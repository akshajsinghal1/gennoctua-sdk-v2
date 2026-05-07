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
import { selectImages, type SelectionProgress } from "./selection.js";
import { FallbackTaggingService } from "./tagging.js";
import { checkEligibility } from "./mapping.js";
import { normalizeError, rateLimitedError } from "./errors.js";
import type {
  SDKConfig,
  SDKEventName,
  SDKEventMap,
  ProductContext,
  ProductType,
  SelectionSummary,
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
    try {
      assets = await selectImages(fileList, (p) => {
        onProgress?.(p);
        this.bus.emit("selection:started", { fileCount });
      });
    } catch (e) {
      const err = normalizeError(e);
      this.bus.emit("upload:failed", { error: err.message });
      this.bus.emit("error", err);
      throw err;
    }

    // Run fallback tagging if needed (silently skips if rate limited or API unavailable)
    const allCategories: UserImageCategory[] = [
      "male_full_body", "female_full_body", "child_full_body",
      "male_face_closeup", "female_face_closeup", "child_face_closeup",
    ];
    const taggedAssets = await this.taggingSvc.maybeTag(assets, allCategories);
    this.selectedAssets = taggedAssets;

    const available = [...new Set(taggedAssets.map((a) => a.category))];
    const missing = allCategories.filter((c) => !available.includes(c));

    this.selectionSummary = {
      availableCategories: available,
      missingCategories: missing,
      totalUploaded: fileCount,
      totalSelected: taggedAssets.length,
    };

    this.analytics.selectionCompleted(fileCount, assets.length, available);
    this.bus.emit("upload:completed", { fileCount, validCount: assets.length });
    this.bus.emit("selection:completed", this.selectionSummary);
    this.dbg.setSelectionSummary(this.selectionSummary, null);

    return this.selectionSummary;
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

  async personalize(overrides?: {
    imageUrl?: string;
    productType?: ProductType;
    productId?: string;
  }): Promise<PersonalizationResult> {
    // Resolve product context
    const ctx = overrides
      ? await this.resolveProduct(overrides)
      : (this.currentProductContext ?? await this.resolveProduct());

    // Check eligibility
    const eligibility = await this.getEligibility(ctx.productType);
    if (!eligibility.eligible) {
      throw normalizeError(
        new Error(
          `Product not eligible for personalization: ${eligibility.reason}`,
        ),
      );
    }

    // Find the matching user image asset
    const requiredCategory = eligibility.requiredCategory;
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

    const promise = this.personalizationSvc.personalize({
      userImage: asset.blob,
      userImageHash: asset.hash,
      userImageCategory: asset.category,
      productImageUrl: ctx.image.imageUrl,
      productImageHash: ctx.image.imageUrl, // URL used as hash for product images
      productType: ctx.productType,
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
        const eligibility = checkEligibility(p.productType, this.selectionSummary);
        if (!eligibility.eligible) {
          return {
            productId: p.productId,
            status: "ineligible",
            reason: eligibility.reason,
          };
        }

        const asset = this.selectedAssets.find(
          (a) => a.category === (eligibility as EligibilityResult & { eligible: true }).requiredCategory,
        );
        if (!asset) {
          return { productId: p.productId, status: "ineligible", reason: "REQUIRED_USER_IMAGE_MISSING" };
        }

        try {
          const result = await this.personalizationSvc.personalize({
            userImage: asset.blob,
            userImageHash: asset.hash,
            userImageCategory: asset.category,
            productImageUrl: p.imageUrl,
            productImageHash: p.imageUrl,
            productType: p.productType,
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

  cancel(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.bus.emit("personalization:cancelled", {});
  }

  reset(): void {
    this.cancel();
    this.selectedAssets = [];
    this.selectionSummary = null;
    this.currentProductContext = null;
    this.viewMode = "original";
    this.rateLimit.reset();
    this.dbg.setProductContext(null);
    this.dbg.setSelectionSummary(null, null);
    this.dbg.setEligibility(null);
    this.dbg.setPersonalizationState("idle");
  }
}

// ─── Top-level Personalize namespace ─────────────────────────────────────────

export const Personalize = {
  init: PersonalizeSDK.init,
};
