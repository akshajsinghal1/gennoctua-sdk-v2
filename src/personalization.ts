import type { ApiClient } from "./api-client.js";
import type { CacheService } from "./cache.js";
import type { ResolvedConfig } from "./config.js";
import type { AnalyticsService } from "./analytics.js";
import type { EventBus } from "./event-bus.js";
import { jobFailedError, jobTimeoutError, normalizeError } from "./errors.js";
import type { PersonalizationResult, ProductType, UserImageCategory } from "./types.js";

// ─── Broad category sent to HyperPersona ─────────────────────────────────────

const BROAD_CATEGORY: Record<ProductType, string> = {
  sunglasses:             "eyewear",
  eyeglasses:             "eyewear",
  mens_clothing:          "clothing",
  womens_clothing:        "clothing",
  kids_clothing:          "clothing",
  footwear:               "footwear",
  jewellery:              "jewellery",
  earrings:               "jewellery",
  bags:                   "accessories",
  makeup_lipstick:        "makeup",
  makeup_foundation:      "makeup",
  makeup_mascara:         "makeup",
  bedroom_furniture:      "accessories",
  bathroom_furniture:     "accessories",
  living_room_furniture:  "accessories",
  kitchen_furniture:      "accessories",
  home_decor:             "accessories",
};

// ─── Descriptive product_type label sent to HyperPersona ─────────────────────

const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
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
    userImageHash: string;
    userImageCategory: UserImageCategory;
    productImageUrl: string;
    productImageHash: string;
    productType: ProductType;
    productId?: string;
    abortSignal?: AbortSignal;
  }): Promise<PersonalizationResult> {
    const {
      userImage,
      userImageHash,
      userImageCategory,
      productImageUrl,
      productImageHash,
      productType,
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
    if (!jobId) {
      const form = new FormData();
      form.append("user_image", userImage, "profile.jpg");
      form.append("garment_image_url", productImageUrl);
      form.append("product_type", PRODUCT_TYPE_LABEL[productType] ?? productType);
      form.append("category", BROAD_CATEGORY[productType] ?? "accessories");

      if (abortSignal?.aborted) {
        this.bus.emit("personalization:cancelled", {});
        throw new Error("Cancelled");
      }

      const { ENDPOINTS } = await import("./api-client.js");
      const body = await this.api.post(ENDPOINTS.submit, form) as Record<string, unknown>;
      jobId = typeof body.job_id === "string" ? body.job_id : null;
      if (!jobId) throw jobFailedError({ response: body });

      await this.cache.setActiveJob(activeJobKey, jobId);
      this.analytics.personalizationJobCreated(jobId);
      this.bus.emit("personalization:job_created", { jobId });
    }

    // ── 4. Stream SSE until COMPLETED or FAILED ──────────────────────────────
    this.bus.emit("personalization:polling_started", { jobId });

    const { ENDPOINTS } = await import("./api-client.js");
    const statusPath = `${ENDPOINTS.status}/${jobId}`;

    return new Promise((resolve, reject) => {
      let settled = false;

      // Timeout safety net
      const timeoutMs = this.config.pollIntervalMs * this.config.pollMaxAttempts;
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.cache.clearActiveJob(activeJobKey);
        reject(jobTimeoutError(this.config.pollMaxAttempts));
      }, timeoutMs);

      this.api.stream(
        statusPath,
        async (event) => {
          if (settled) return;
          const status = event.status as string | undefined;
          const resultUrl = event.result_url as string | undefined;

          if (status === "COMPLETED" && resultUrl) {
            settled = true;
            clearTimeout(timeoutHandle);
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
