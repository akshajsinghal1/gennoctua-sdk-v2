import type { ApiClient } from "./api-client.js";
import type { CacheService } from "./cache.js";
import type { ResolvedConfig } from "./config.js";
import type { AnalyticsService } from "./analytics.js";
import type { EventBus } from "./event-bus.js";
import { jobFailedError, jobTimeoutError, normalizeError } from "./errors.js";
import type { HpCategory, PersonalizationResult, UserImageCategory } from "./types.js";


// ─── Pose tag derived from user image category ────────────────────────────────
// Sent as `tag` field in the job submit payload. Tells the backend how much of
// the body is visible, so generation strategy can be adjusted accordingly.
// 1 = full body  |  2 = partial (knees up)  |  3 = face / upper body only
const POSE_TAG_FROM_CATEGORY: Partial<Record<UserImageCategory, string>> = {
  male_full_body:      "1",
  female_full_body:    "1",
  kid_boy_full_body:   "1",
  kid_girl_full_body:  "1",
  male_face_closeup:   "3",
  female_face_closeup: "3",
  kid_boy_face_closeup:  "3",
  kid_girl_face_closeup: "3",
  // room_* categories intentionally omitted — no pose concept for furniture
};


// ─── Descriptive product_type label sent to HyperPersona ─────────────────────

const PRODUCT_TYPE_LABEL: Partial<Record<string, string>> = {
  sunglasses:             "sunglasses",
  eyeglasses:             "eyeglasses",
  mens_clothing:          "mens clothing",
  womens_clothing:        "womens clothing",
  kids_clothing:          "kids clothing",
  footwear:               "footwear",
  jewellery:              "jewellery necklace",
  earrings:               "earrings",
  bags:                   "bag",
  makeup_lipstick:        "lipstick",
  makeup_foundation:      "foundation",
  makeup_mascara:         "mascara",
  bedroom_furniture:      "bedroom furniture",
  bathroom_furniture:     "bathroom furniture",
  living_room_furniture:  "living room furniture",
  dining_room_furniture:  "dining room furniture",
  kitchen_furniture:      "kitchen furniture",
  home_decor:             "home decor",
};

// ─── PersonalizationService ───────────────────────────────────────────────────

export class PersonalizationService {
  private api: ApiClient;
  private cache: CacheService;
  private config: ResolvedConfig;
  private analytics: AnalyticsService;
  private bus: EventBus;
  private orgId: string;

  constructor(
    api: ApiClient,
    cache: CacheService,
    config: ResolvedConfig,
    analytics: AnalyticsService,
    bus: EventBus,
    orgId: string,
  ) {
    this.api = api;
    this.cache = cache;
    this.config = config;
    this.analytics = analytics;
    this.bus = bus;
    this.orgId = orgId;
  }

  async personalize(opts: {
    userImage: Blob;
    /** Pre-uploaded GCS URL. When present, sent as user_image_url instead of
     *  re-uploading the blob — saves bandwidth for large product catalogs. */
    userImageUrl?: string;
    userImageHash: string;
    userImageCategory: UserImageCategory;
    productImageUrl: string;
    productImageHash: string;
    productType: ProductType;
    /** The broad category sent to HyperPersona. Controls job routing on the backend. */
    category: HpCategory;
    productId?: string;
    abortSignal?: AbortSignal;
  }): Promise<PersonalizationResult> {
    const {
      userImage,
      userImageUrl,
      userImageHash,
      userImageCategory,
      productImageUrl,
      productImageHash,
      productType,
      category,
      abortSignal,
    } = opts;

    const cacheKey = this.cache.resultKey(
      this.orgId,
      userImageHash,
      productImageHash,
      productType,
    );

    // ── 1. Check result cache ────────────────────────────────────────────────
    const cached = await this.cache.getResult(cacheKey);
    if (cached) {
      this.analytics.personalizationCacheHit(cacheKey, productType);
      this.bus.emit("personalization:cache_hit", { imageUrl: cached, cacheHit: true, jobId: cacheKey });
      return { imageUrl: cached, cacheHit: true, jobId: cacheKey };
    }

    this.analytics.personalizationRequested(productImageUrl, productType);
    this.bus.emit("personalization:requested", { productImageUrl });

    // ── 2. Check for restorable active job ───────────────────────────────────
    let jobId: string | null = null;
    const activeJobKey = this.cache.activeJobKey(this.orgId, cacheKey);

    if (this.config.cache.restoreActiveJobs) {
      const activeJob = await this.cache.getActiveJob(activeJobKey);
      if (activeJob && Date.now() - activeJob.startedAt < this.config.cache.activeJobMaxAgeMs) {
        jobId = activeJob.jobId;
        console.info(`[personalize-sdk] Restoring active job ${jobId}`);
      }
    }

    // ── 3. Submit job if no active job ───────────────────────────────────────
    const { ENDPOINTS } = await import("./api-client.js");
    const isFurniture = category === "furniture";

    if (!jobId) {
      if (abortSignal?.aborted) {
        this.bus.emit("personalization:cancelled", {});
        throw new Error("Cancelled");
      }

      const form = new FormData();
      let submitPath: string;

      if (isFurniture) {
        // ── Furniture try-on (Hyperpersona) ───────────────────────────────────
        // POST /submit → proxied to HP POST /api/tryon/submit
        //   user_image         — room photo (blob)
        //   garment_image_url  — furniture product image URL
        //   product_type       — descriptive label
        //   category           — must be "furniture"
        form.append("user_image", userImage, "room.jpg");
        void userImageUrl;
        form.append("garment_image_url", productImageUrl);
        form.append("product_type", PRODUCT_TYPE_LABEL[productType] ?? productType);
        form.append("category", category);
        submitPath = ENDPOINTS.submit;
      } else {
        // ── Person try-on flow ───────────────────────────────────────────────
        // POST /submit (proxied to category-specific endpoint)
        //   user_image        — person photo (always send blob — HP does not accept URLs)
        //   garment_image_url — product image
        //   product_type      — descriptive label
        //   category          — broad category
        //   tag               — pose score (body visibility)
        form.append("user_image", userImage, "profile.jpg");
        void userImageUrl; // GCS URL used only for profile LLM, not for HP submit
        form.append("garment_image_url", productImageUrl);
        form.append("product_type", PRODUCT_TYPE_LABEL[productType] ?? productType);
        form.append("category", category);

        // tag = pose score — tells backend how much body is visible.
        //   1 = full body (ankles visible) — best for clothing/footwear
        //   3 = face / upper body only
        // Room photos carry no tag.
        const poseTag = POSE_TAG_FROM_CATEGORY[userImageCategory];
        if (poseTag !== undefined) {
          form.append("tag", poseTag);
        }
        submitPath = ENDPOINTS.submit;
      }

      const body = await this.api.post(submitPath, form) as Record<string, unknown>;
      jobId = typeof body.job_id === "string" ? body.job_id : null;
      if (!jobId) throw jobFailedError({ response: body });

      await this.cache.setActiveJob(activeJobKey, jobId);
      this.analytics.personalizationJobCreated(jobId);
      this.bus.emit("personalization:job_created", { jobId });
    }

    // ── 4. Stream SSE until COMPLETED or FAILED ──────────────────────────────
    this.bus.emit("personalization:polling_started", { jobId });

    // Person and furniture try-on both use HP GET /api/tryon/status/:jobId (SSE).
    const statusPath = `${ENDPOINTS.status}/${jobId}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const pollingStartedAt = Date.now();

      // Timeout safety net
      const timeoutMs = this.config.pollIntervalMs * this.config.pollMaxAttempts;
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(slowHandle);
        void this.cache.clearActiveJob(activeJobKey);
        reject(jobTimeoutError(this.config.pollMaxAttempts));
      }, timeoutMs);

      // Slow threshold — fires if result hasn't arrived within slowThresholdMs
      const slowHandle = setTimeout(() => {
        if (settled) return;
        this.bus.emit("personalization:slow", {
          jobId: jobId!,
          elapsedMs: Date.now() - pollingStartedAt,
        });
      }, this.config.slowThresholdMs);

      this.api.stream(
        statusPath,
        async (event) => {
          if (settled) return;
          const status = event.status as string | undefined;
          const resultUrl = event.result_url as string | undefined;

          if (status === "COMPLETED" && resultUrl) {
            settled = true;
            clearTimeout(timeoutHandle);
            clearTimeout(slowHandle);
            const clean = `${resultUrl.split("?")[0]}?t=${Date.now()}`;
            await this.cache.setResult(cacheKey, clean, this.config.cache.resultTtlMs);
            await this.cache.clearActiveJob(activeJobKey);
            this.analytics.personalizationCompleted(jobId!, productType, false);
            this.bus.emit("personalization:completed", { imageUrl: clean, cacheHit: false, jobId: jobId! });
            resolve({ imageUrl: clean, cacheHit: false, jobId: jobId! });
          }

          if (status === "FAILED") {
            settled = true;
            clearTimeout(timeoutHandle);
            clearTimeout(slowHandle);
            await this.cache.clearActiveJob(activeJobKey);
            const message = (event.message as string | undefined) ?? "Try-on job failed on server";
            reject(jobFailedError({ jobId, message }));
          }
        },
        abortSignal,
      ).catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        clearTimeout(slowHandle);
        void this.cache.clearActiveJob(activeJobKey);
        if ((e as Error).name === "AbortError") {
          this.bus.emit("personalization:cancelled", { jobId: jobId ?? undefined });
          reject(new Error("Cancelled"));
        } else {
          reject(normalizeError(e));
        }
      });
    });
  }
}
