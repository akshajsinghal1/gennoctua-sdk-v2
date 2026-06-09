import { resolveConfig, getOrgId, type ResolvedConfig } from "./config.js";
import { AuthService } from "./auth.js";
import { ApiClient } from "./api-client.js";
import { CacheService } from "./cache.js";
import { RateLimitService } from "./rate-limit.js";
import { AnalyticsService } from "./analytics.js";
import { EventBus } from "./event-bus.js";
import { DebugService } from "./debug.js";
import { ProductContextService } from "./product-context.js";
import { PersonalizationService } from "./personalization.js";
import { selectImages, type SelectionProgress, type TopCandidatesMap, type TopCandidate } from "./selection.js";
import type { LLMCandidate, LLMRoomCandidate } from "./api-client.js";
import type { TopRoomCandidatesMap } from "./types.js";
import { FallbackTaggingService } from "./tagging.js";
import { checkEligibility, resolveCategoryFromGender } from "./mapping.js";
import { normalizeError, rateLimitedError } from "./errors.js";
import type {
  SDKConfig,
  SDKEventName,
  SDKEventMap,
  ProductContext,
  ProductType,
  HpCategory,
  UserGender,
  SelectionSummary,
  RejectionReason,
  RejectionReasonCode,
  EligibilityResult,
  PersonalizationResult,
  ViewMode,
  BatchProduct,
  BatchResult,
  SelectedImageAsset,
  UserImageCategory,
} from "./types.js";

// ─── PersonalizeSDK ───────────────────────────────────────────────────────────

export class PersonalizeSDK {
  private config: ResolvedConfig;
  private bus: EventBus;
  private auth: AuthService;
  private api: ApiClient;
  private cacheService: CacheService;
  private rateLimit: RateLimitService;
  private analytics: AnalyticsService;
  private dbg: DebugService;
  private productCtx: ProductContextService;
  private personalizationSvc: PersonalizationService;
  private taggingSvc: FallbackTaggingService;
  private orgId: string;
  private sessionId: string;

  // Mutable state
  private selectedAssets: SelectedImageAsset[] = [];
  private selectionSummary: SelectionSummary | null = null;
  private currentProductContext: ProductContext | null = null;
  private viewMode: ViewMode = "original";
  private activeAbortController: AbortController | null = null;

  /** GCS URLs keyed by asset hash — populated in background after ingestImages() */
  private profileUrlCache = new Map<string, string>();

  private constructor(
    config: ResolvedConfig,
    orgId: string,
    sessionId: string,
  ) {
    this.config = config;
    this.orgId = orgId;
    this.sessionId = sessionId;

    this.bus = new EventBus();
    this.auth = new AuthService(config);
    this.api = new ApiClient(this.auth);
    this.cacheService = new CacheService();
    this.rateLimit = new RateLimitService(config.rateLimit);
    this.analytics = new AnalyticsService(config.analytics, orgId, sessionId);
    this.dbg = new DebugService(config.debug);
    this.productCtx = new ProductContextService(config.product, this.api);
    this.personalizationSvc = new PersonalizationService(
      this.api,
      this.cacheService,
      config,
      this.analytics,
      this.bus,
      orgId,
    );
    this.taggingSvc = new FallbackTaggingService(this.api, this.rateLimit, orgId, sessionId);
  }

  // ── Static factory ──────────────────────────────────────────────────────────

  static async init(config: SDKConfig): Promise<PersonalizeSDK> {
    const resolved = resolveConfig(config); // throws SDKError on invalid config
    const orgId = getOrgId(resolved) ?? "unknown";
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new PersonalizeSDK(resolved, orgId, sessionId);
  }

  // ── Image ingestion + selection ─────────────────────────────────────────────

  async ingestImages(
    fileList: FileList | null | undefined,
    onProgress?: (p: SelectionProgress) => void,
  ): Promise<SelectionSummary> {
    const fileCount = fileList?.length ?? 0;
    this.analytics.uploadStarted(fileCount);
    this.bus.emit("upload:started", { fileCount });
    this.dbg.log("ingest_images", { fileCount });

    let assets: SelectedImageAsset[];
    let topCandidates: TopCandidatesMap;
    let topRoomCandidates: TopRoomCandidatesMap;
    let selectionRejections: Record<RejectionReasonCode, number> = {
      no_face_detected: 0, multiple_people: 0,
      low_gender_confidence: 0, not_front_facing: 0, no_full_body: 0,
    };
    try {
      const output = await selectImages(
        fileList,
        (p) => {
          onProgress?.(p);
          this.bus.emit("selection:started", { fileCount });
        },
        this.config.personalizationMode,
      );
      assets = output.assets;
      topCandidates = output.topCandidates;
      topRoomCandidates = output.topRoomCandidates;
      selectionRejections = output.rejections;
    } catch (e) {
      const err = normalizeError(e);
      this.bus.emit("upload:failed", { error: err.message });
      this.bus.emit("error", err);
      throw err;
    }

    // Run fallback tagging if needed (silently skips if rate limited or API unavailable)
    const allCategories: UserImageCategory[] = [
      // Person — fashion try-on
      "male_full_body", "female_full_body", "kid_boy_full_body", "kid_girl_full_body",
      "male_face_closeup", "female_face_closeup", "kid_boy_face_closeup", "kid_girl_face_closeup",
      // Room — furniture & home decor try-on
      "room_bedroom", "room_living_room", "room_dining_room", "room_kitchen", "room_bathroom",
    ];
    let taggedAssets = await this.taggingSvc.maybeTag(assets, allCategories);

    // Optional LLM refinement for person photos
    taggedAssets = await this.refineSelectionWithLLM(taggedAssets, topCandidates);

    // Optional LLM refinement for room photos
    taggedAssets = await this.refineRoomsWithLLM(taggedAssets, topRoomCandidates);

    this.selectedAssets = taggedAssets;

    // Pre-upload profiles to GCS in background — no await, won't block the caller
    void this.uploadProfilesInBackground(taggedAssets);

    const available = [...new Set(taggedAssets.map((a) => a.category))];
    const missing = allCategories.filter((c) => !available.includes(c));

    const rejectionReasons: RejectionReason[] = (
      Object.entries(selectionRejections) as [RejectionReasonCode, number][]
    )
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => ({ reason, count }));

    this.selectionSummary = {
      availableCategories: available,
      missingCategories: missing,
      totalUploaded: fileCount,
      totalSelected: taggedAssets.length,
      rejectionReasons,
    };

    this.analytics.selectionCompleted(fileCount, assets.length, available);
    this.bus.emit("upload:completed", { fileCount, validCount: assets.length });
    this.bus.emit("selection:completed", this.selectionSummary);
    this.dbg.setSelectionSummary(this.selectionSummary, null);

    // Persist profile so returning users skip the AI pipeline entirely.
    // Blobs are stored natively in IndexedDB — no base64 conversion needed.
    // GCS URLs are patched in incrementally as background uploads complete.
    void this.cacheService.saveProfile(
      this.orgId,
      taggedAssets,
      Object.fromEntries(this.profileUrlCache),
      this.config.cache.selectionTtlMs,
    ).catch(() => { /* ignore cache errors */ });

    return this.selectionSummary;
  }

  // ── Profile restore ─────────────────────────────────────────────────────────

  /**
   * Restore a previously selected profile from cache.
   * Call this on page load — if a cached profile exists, the user can skip
   * the upload step entirely and go straight to personalization.
   *
   * Returns the SelectionSummary if a valid cached profile was found,
   * or null if no cache exists / cache has expired.
   */
  async restoreProfile(): Promise<SelectionSummary | null> {
    try {
      const cached = await this.cacheService.loadProfile(this.orgId);
      if (!cached || cached.assets.length === 0) return null;

      this.selectedAssets = cached.assets;

      // Restore GCS URL cache so personalize() avoids re-uploading blobs
      for (const [hash, url] of Object.entries(cached.profileUrls)) {
        this.profileUrlCache.set(hash, url);
      }

      // Re-upload any assets that don't have a GCS URL yet
      // (e.g. user left the page before background upload finished)
      const missingUploads = cached.assets.filter(
        (a) => !this.profileUrlCache.has(a.hash),
      );
      if (missingUploads.length > 0) {
        void this.uploadProfilesInBackground(missingUploads);
      }

      const allCategories: UserImageCategory[] = [
        "male_full_body", "female_full_body", "kid_boy_full_body", "kid_girl_full_body",
        "male_face_closeup", "female_face_closeup", "kid_boy_face_closeup", "kid_girl_face_closeup",
        "room_bedroom", "room_living_room", "room_dining_room", "room_kitchen", "room_bathroom",
      ];

      const available = [...new Set(cached.assets.map((a) => a.category))];
      const missing = allCategories.filter((c) => !available.includes(c));

      this.selectionSummary = {
        availableCategories: available,
        missingCategories: missing,
        totalUploaded: 0,   // unknown on restore
        totalSelected: cached.assets.length,
        rejectionReasons: [], // no pipeline ran — profile came from cache
      };

      this.dbg.setSelectionSummary(this.selectionSummary, null);
      this.bus.emit("selection:completed", this.selectionSummary);
      this.dbg.log("profile_restored", { categories: available });

      return this.selectionSummary;
    } catch {
      return null; // cache unavailable — caller should show upload UI
    }
  }

  // ── Product context ─────────────────────────────────────────────────────────

  async resolveProduct(overrides?: {
    imageUrl?: string;
    productType?: ProductType;
    productId?: string;
    productTitle?: string;
  }): Promise<ProductContext> {
    let ctx: ProductContext;
    try {
      ctx = await this.productCtx.getContext(overrides);
    } catch (e) {
      const err = normalizeError(e);
      this.bus.emit("product:failed", { error: err.message });
      throw err;
    }
    this.currentProductContext = ctx;
    this.bus.emit("product:resolved", ctx);
    this.dbg.setProductContext(ctx);
    return ctx;
  }

  // ── Eligibility ─────────────────────────────────────────────────────────────

  async getEligibility(productType?: ProductType): Promise<EligibilityResult> {
    const type = productType ?? this.currentProductContext?.productType;
    const result = checkEligibility(type, this.selectionSummary);

    this.dbg.setEligibility(result);

    if (result.eligible) {
      this.bus.emit("eligibility:eligible", result as EligibilityResult & { eligible: true });
    } else {
      this.bus.emit("eligibility:ineligible", result as EligibilityResult & { eligible: false });
    }

    return result;
  }

  // ── Single-product personalization ─────────────────────────────────────────

  async personalize(opts: {
    imageUrl: string;
    productType: ProductType;
    /** Required for person products (clothing, eyewear, footwear, etc.).
     *  Not needed when category is "furniture". */
    gender?: UserGender;
    /** The broad category sent to HyperPersona. Controls job routing on the backend. */
    category: HpCategory;
    productId?: string;
    abortSignal?: AbortSignal;
  }): Promise<PersonalizationResult> {
    const { imageUrl, productType, gender, category, productId } = opts;

    // Resolve product context
    const ctx = await this.resolveProduct({ imageUrl, productType, productId });

    let requiredCategory: UserImageCategory;

    if (category === "furniture") {
      // Furniture / room product — resolve via eligibility (room photo required)
      const eligibility = await this.getEligibility(ctx.productType);
      if (!eligibility.eligible) {
        throw normalizeError(new Error(`Product not eligible for personalization: ${eligibility.reason}`));
      }
      requiredCategory = eligibility.requiredCategory;
    } else {
      // Person product — gender required
      if (!gender) {
        throw normalizeError(new Error(`gender is required for category "${category}"`));
      }
      const resolvedCategory = resolveCategoryFromGender(ctx.productType, gender);
      requiredCategory = resolvedCategory ?? (gender === "male" ? "male_full_body" : "female_full_body");
      const hasCategory = this.selectionSummary?.availableCategories.includes(requiredCategory);
      if (!hasCategory) {
        throw normalizeError(new Error(
          `No ${requiredCategory} photo found. Upload a ${gender} photo first.`,
        ));
      }
    }

    // Find the matching user image asset
    const asset = this.selectedAssets.find((a) => a.category === requiredCategory);
    if (!asset) {
      throw normalizeError(new Error(`No asset found for category ${requiredCategory}`));
    }

    const productKey = `${ctx.image.imageUrl}:${ctx.productType}`;

    // Client-side rate limiting
    try {
      this.rateLimit.checkPersonalization(productKey);
    } catch (e) {
      this.analytics.rateLimitedClient();
      this.bus.emit("personalization:rate_limited", { reason: "client_rate_limit" });
      throw e;
    }

    // Single-flight deduplication
    const cfg = this.config.rateLimit.personalization;
    if (cfg?.singleFlight) {
      const inFlight = this.rateLimit.getInFlight<PersonalizationResult>(productKey);
      if (inFlight) return inFlight;
    }

    // Set up cancellation
    this.activeAbortController = new AbortController();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => this.activeAbortController?.abort());
    }

    const promise = this.personalizationSvc.personalize({
      userImage: asset.blob,
      userImageUrl: this.profileUrlCache.get(asset.hash),
      userImageHash: asset.hash,
      userImageCategory: asset.category,
      productImageUrl: ctx.image.imageUrl,
      productImageHash: ctx.image.imageUrl,
      productType: ctx.productType,
      category,
      productId: ctx.productId,
      abortSignal: this.activeAbortController.signal,
    });

    this.rateLimit.registerInFlight(productKey, promise);
    this.rateLimit.recordPersonalization(productKey);
    this.dbg.setPersonalizationState("creating_job");

    try {
      const result = await promise;
      this.viewMode = "personalized";
      this.bus.emit("view:changed", { mode: "personalized" });
      this.dbg.setPersonalizationState("personalized", result.jobId);
      return result;
    } catch (e) {
      const err = normalizeError(e);
      this.dbg.setPersonalizationState("failed", null, err.message);
      this.analytics.personalizationFailed(err.message, err.code);
      this.bus.emit("personalization:failed", { error: err.message, code: err.code });
      this.bus.emit("error", err);
      throw err;
    } finally {
      this.activeAbortController = null;
    }
  }

  // ── Batch personalization ───────────────────────────────────────────────────

  async personalizeAll(
    products: BatchProduct[],
    onResult?: (result: BatchResult) => void,
  ): Promise<BatchResult[]> {
    const results = await Promise.allSettled(
      products.map(async (p): Promise<BatchResult> => {
        // Resolve category from gender (person) or productType (furniture)
        let requiredCategory: UserImageCategory;

        if (p.category === "furniture") {
          // Room product — resolve via eligibility
          const eligibility = checkEligibility(p.productType, this.selectionSummary);
          if (!eligibility.eligible) {
            const r: BatchResult = { productId: p.productId, status: "ineligible", reason: eligibility.reason };
            onResult?.(r);
            return r;
          }
          requiredCategory = (eligibility as EligibilityResult & { eligible: true }).requiredCategory;
        } else {
          // Person product — gender required
          if (!p.gender) {
            const r: BatchResult = { productId: p.productId, status: "failed", error: `gender is required for category "${p.category}"` };
            onResult?.(r);
            return r;
          }
          const resolvedCategory = resolveCategoryFromGender(p.productType, p.gender);
          requiredCategory = resolvedCategory ?? (p.gender === "male" ? "male_full_body" : "female_full_body");
          const hasCategory = this.selectionSummary?.availableCategories.includes(requiredCategory);
          if (!hasCategory) {
            const r: BatchResult = { productId: p.productId, status: "ineligible", reason: "REQUIRED_USER_IMAGE_MISSING" };
            onResult?.(r);
            return r;
          }
        }

        const asset = this.selectedAssets.find((a) => a.category === requiredCategory);
        if (!asset) {
          const r: BatchResult = { productId: p.productId, status: "ineligible", reason: "REQUIRED_USER_IMAGE_MISSING" };
          onResult?.(r);
          return r;
        }

        try {
          const result = await this.personalizationSvc.personalize({
            userImage: asset.blob,
            userImageUrl: this.profileUrlCache.get(asset.hash),
            userImageHash: asset.hash,
            userImageCategory: asset.category,
            productImageUrl: p.imageUrl,
            productImageHash: p.imageUrl,
            productType: p.productType,
            category: p.category,
            productId: p.productId,
          });
          const r: BatchResult = {
            productId: p.productId,
            status: "completed",
            imageUrl: result.imageUrl,
            cacheHit: result.cacheHit,
            jobId: result.jobId,
          };
          onResult?.(r);
          return r;
        } catch (e) {
          const r: BatchResult = {
            productId: p.productId,
            status: "failed",
            error: normalizeError(e).message,
          };
          onResult?.(r);
          return r;
        }
      }),
    );

    return results.map((r) =>
      r.status === "fulfilled" ? r.value : { productId: "unknown", status: "failed", error: String(r.reason) },
    );
  }

  // ── View helpers ────────────────────────────────────────────────────────────

  view = {
    showOriginal: () => {
      this.viewMode = "original";
      this.bus.emit("view:changed", { mode: "original" });
      this.analytics.viewChanged("original");
      this.dbg.setViewMode("original");
    },
    showPersonalized: () => {
      this.viewMode = "personalized";
      this.bus.emit("view:changed", { mode: "personalized" });
      this.analytics.viewChanged("personalized");
      this.dbg.setViewMode("personalized");
    },
    toggle: () => {
      const next: ViewMode = this.viewMode === "original" ? "personalized" : "original";
      if (next === "original") this.view.showOriginal();
      else this.view.showPersonalized();
    },
    getMode: (): ViewMode => this.viewMode,
  };

  // ── Selection summary ───────────────────────────────────────────────────────

  selection = {
    getSummary: (): SelectionSummary | null => this.selectionSummary,
    getAssets: (): SelectedImageAsset[] => [...this.selectedAssets],
  };

  // ── Product ─────────────────────────────────────────────────────────────────

  product = {
    getContext: (): ProductContext | null => this.currentProductContext,
    refreshContext: (overrides?: Parameters<PersonalizeSDK["resolveProduct"]>[0]) =>
      this.resolveProduct(overrides),
  };

  // ── Cache ───────────────────────────────────────────────────────────────────

  cache = {
    clearProfile: () => this.cacheService.clearProfile(this.orgId),
    clearSelection: () => this.cacheService.clearSelection(),
    clearPersonalization: () => this.cacheService.clearPersonalization(),
    clearAll: () => this.cacheService.clearAll(),
  };

  // ── Events ──────────────────────────────────────────────────────────────────

  on<K extends SDKEventName>(event: K, handler: (payload: SDKEventMap[K]) => void): () => void {
    return this.bus.on(event, handler);
  }

  off<K extends SDKEventName>(event: K, handler: (payload: SDKEventMap[K]) => void): void {
    this.bus.off(event, handler);
  }

  // ── Debug ───────────────────────────────────────────────────────────────────

  debug = {
    getState: () => this.dbg.getState(),
  };

  // ── Cancel + Reset ───────────────────────────────────────────────────────────

  // ── Private: GCS profile pre-upload ────────────────────────────────────────

  /**
   * Upload each unique selected asset to GCS in the background.
   * When a product submission fires later, profileUrlCache will already have
   * the URL — so we send user_image_url instead of re-uploading the blob.
   * Silent on failure: personalize() falls back to raw blob upload.
   */
  private uploadProfilesInBackground(assets: SelectedImageAsset[]): void {
    const seen = new Set<string>();
    for (const asset of assets) {
      if (seen.has(asset.hash) || this.profileUrlCache.has(asset.hash)) continue;
      seen.add(asset.hash);
      void (async () => {
        try {
          const url = await this.api.uploadUserImage(asset.blob, asset.hash);
          this.profileUrlCache.set(asset.hash, url);
          this.dbg.log("profile_upload_ok", { hash: asset.hash });
          // Patch the new GCS URL into the persisted profile record
          void this.cacheService.updateProfileUrls(this.orgId, { [asset.hash]: url })
            .catch(() => { /* ignore */ });
        } catch (e) {
          this.dbg.log("profile_upload_failed", { hash: asset.hash, error: normalizeError(e).message });
          // Silently ignored — personalize() will fall back to raw blob
        }
      })();
    }
  }

  // ── Private: LLM profile refinement ────────────────────────────────────────

  /**
   * Optionally refine the local-AI selection using the Gennoctua LLM picker.
   * Compresses top-5 candidates per category to 512px, sends to /api/profile/select,
   * and swaps out any asset where the LLM found a better pick.
   * Falls back silently to the original assets on any error or timeout.
   */
  private async refineSelectionWithLLM(
    assets: SelectedImageAsset[],
    topCandidates: TopCandidatesMap,
  ): Promise<SelectedImageAsset[]> {
    const hasAnyCandidates = Object.values(topCandidates).some(arr => arr.length > 0);
    if (!hasAnyCandidates) return assets;

    try {
      // Compress each candidate to 512px data URL for LLM vision
      const compress = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
          const img = new Image();
          const objectUrl = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            const maxSide = 512;
            const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.max(1, Math.round(img.naturalWidth * scale));
            const h = Math.max(1, Math.round(img.naturalHeight * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.8));
          };
          img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("compress failed")); };
          img.src = objectUrl;
        });

      // Build ID → TopCandidate lookup for mapping LLM result back to files
      const idToCandidate = new Map<string, TopCandidate>();

      const buildPayload = async (
        cat: keyof TopCandidatesMap,
        gender: "male" | "female" | "unknown",
      ): Promise<LLMCandidate[]> => {
        const result: LLMCandidate[] = [];
        for (let i = 0; i < topCandidates[cat].length; i++) {
          const c = topCandidates[cat][i];
          const id = `${cat}_${i}`;
          idToCandidate.set(id, c);
          const imageDataUrl = await compress(c.file).catch(() => "");
          if (!imageDataUrl) continue;
          result.push({
            id,
            imageDataUrl,
            poseScore: c.poseRank,
            faceCount: 1,
            photoName: c.file.name,
            detectedGender: gender,
            detectedAge: Math.round(c.age),
          });
        }
        return result;
      };

      const [male, female, kid_boy, kid_girl] = await Promise.all([
        buildPayload("male",    "male"),
        buildPayload("female",  "female"),
        buildPayload("kid_boy", "male"),
        buildPayload("kid_girl","female"),
      ]);

      const llmResult = await this.api.selectProfilesWithLLM({ categories: { male, female, kid_boy, kid_girl } });

      if (llmResult.skipped) return assets;

      // Map LLM picks back to SelectedImageAssets
      const updatedAssets = [...assets];

      for (const [catKey, selectedId] of Object.entries(llmResult.selected) as [keyof typeof llmResult.selected, string | null][]) {
        if (!selectedId) continue;
        const candidate = idToCandidate.get(selectedId);
        if (!candidate) continue;

        const newHash = candidate.hash;

        // Determine which categories this pick applies to
        const targetCategories: UserImageCategory[] =
          catKey === "kid_boy"  ? ["kid_boy_full_body",  "kid_boy_face_closeup"]
        : catKey === "kid_girl" ? ["kid_girl_full_body", "kid_girl_face_closeup"]
        : catKey === "male"     ? ["male_full_body",     "male_face_closeup"]
        :                         ["female_full_body",   "female_face_closeup"];

        for (const targetCat of targetCategories) {
          const idx = updatedAssets.findIndex(a => a.category === targetCat);
          if (idx === -1) continue;

          // Only replace full_body if candidate actually has a pose rank (standing photo)
          if ((targetCat === "male_full_body" || targetCat === "female_full_body" ||
               targetCat === "kid_boy_full_body" || targetCat === "kid_girl_full_body")
              && candidate.poseRank === 0) {
            continue; // LLM picked a selfie — don't use it for full body
          }

          updatedAssets[idx] = {
            ...updatedAssets[idx],
            imageId: newHash,
            blob: candidate.file,
            hash: newHash,
            source: "merged",
          };
        }
      }

      this.dbg.log("llm_profile_refinement_ok", { model: llmResult.model });
      return updatedAssets;
    } catch (e) {
      const err = normalizeError(e);
      this.dbg.log("llm_profile_refinement_failed", { error: err.message, details: err.details });
      return assets; // silent fallback to local AI picks
    }
  }

  // ── Private: LLM room refinement ───────────────────────────────────────────

  /**
   * Optionally refine the YOLO room selection using the Gennoctua LLM room picker.
   * Compresses top-5 candidates per room type to 512px, sends to /api/room/select,
   * and swaps out any asset where the LLM found a better pick.
   * Falls back silently to the original YOLO picks on any error or timeout.
   */
  private async refineRoomsWithLLM(
    assets: SelectedImageAsset[],
    topRoomCandidates: TopRoomCandidatesMap,
  ): Promise<SelectedImageAsset[]> {
    const hasAnyCandidates =
      topRoomCandidates.bedroom.length > 0 ||
      topRoomCandidates.living_room.length > 0 ||
      topRoomCandidates.dining_room.length > 0;
    if (!hasAnyCandidates) return assets;

    try {
      // Compress each candidate to 512px data URL for LLM vision
      const compress = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
          const img = new Image();
          const objectUrl = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            const scale = Math.min(1, 512 / Math.max(img.width, img.height));
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.82));
          };
          img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("compress failed")); };
          img.src = objectUrl;
        });

      // Build ID → file lookup for mapping LLM result back to files
      type RoomKey = keyof TopRoomCandidatesMap;
      const idToFile = new Map<string, File>();

      const buildPayload = async (roomKey: RoomKey): Promise<LLMRoomCandidate[]> => {
        const result: LLMRoomCandidate[] = [];
        for (let i = 0; i < topRoomCandidates[roomKey].length; i++) {
          const c = topRoomCandidates[roomKey][i];
          const id = `${roomKey}_${i}`;
          idToFile.set(id, c.file);
          const imageDataUrl = await compress(c.file).catch(() => "");
          if (!imageDataUrl) continue;
          result.push({ id, imageDataUrl, yoloScore: c.yoloScore, topLabel: c.topLabel });
        }
        return result;
      };

      const [bedroom, living_room, dining_room] = await Promise.all([
        buildPayload("bedroom"),
        buildPayload("living_room"),
        buildPayload("dining_room"),
      ]);

      const llmResult = await this.api.selectRoomsWithLLM({ categories: { bedroom, living_room, dining_room } });

      if (llmResult.skipped) return assets;

      // Map LLM picks back to SelectedImageAssets
      const updatedAssets = [...assets];

      const roomKeyToCategory: Record<RoomKey, UserImageCategory> = {
        bedroom:     "room_bedroom",
        living_room: "room_living_room",
        dining_room: "room_dining_room",
      };

      for (const [roomKey, selectedId] of Object.entries(llmResult.selected) as [RoomKey, string | null][]) {
        const targetCat = roomKeyToCategory[roomKey];

        if (!selectedId) {
          // LLM rejected all candidates for this room type — remove the YOLO false positive.
          // Only act if we actually sent candidates (empty array = LLM had nothing to judge).
          if (topRoomCandidates[roomKey].length > 0) {
            const idx = updatedAssets.findIndex(a => a.category === targetCat);
            if (idx !== -1) updatedAssets.splice(idx, 1);
          }
          continue;
        }

        const file = idToFile.get(selectedId);
        if (!file) continue;

        const idx = updatedAssets.findIndex(a => a.category === targetCat);
        if (idx === -1) continue;

        const newHash = `${file.name}-${file.size}-${file.lastModified}`;
        updatedAssets[idx] = {
          ...updatedAssets[idx],
          imageId: newHash,
          blob: file,
          hash: newHash,
          source: "merged",
        };
      }

      this.dbg.log("llm_room_refinement_ok", { model: llmResult.model });
      return updatedAssets;
    } catch (e) {
      this.dbg.log("llm_room_refinement_failed", { error: normalizeError(e).message });
      return assets; // silent fallback to YOLO picks
    }
  }

  cancel(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.bus.emit("personalization:cancelled", {});
  }

  reset(): void {
    this.cancel();
    this.selectedAssets = [];
    this.selectionSummary = null;
    this.profileUrlCache.clear();
    this.currentProductContext = null;
    this.viewMode = "original";
    this.rateLimit.reset();
    this.dbg.setProductContext(null);
    this.dbg.setSelectionSummary(null, null);
    this.dbg.setEligibility(null);
    this.dbg.setPersonalizationState("idle");
    // Clear persisted profile so next page load shows upload UI
    void this.cacheService.clearProfile(this.orgId).catch(() => {});
  }
}

// ─── Top-level Personalize namespace ─────────────────────────────────────────

export const Personalize = {
  init: PersonalizeSDK.init,
};
