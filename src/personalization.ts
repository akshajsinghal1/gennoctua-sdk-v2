import type { ApiClient } from "./api-client.js";
import type { CacheService } from "./cache.js";
import type { ResolvedConfig } from "./config.js";
import type { AnalyticsService } from "./analytics.js";
import type { EventBus } from "./event-bus.js";
import { jobFailedError, jobTimeoutError, normalizeError } from "./errors.js";
import type { PersonalizationResult, ProductType, UserImageCategory } from "./types.js";

// ─── Furniture product types ──────────────────────────────────────────────────

const FURNITURE_PRODUCT_TYPES = new Set<ProductType>([
  "bedroom_furniture",
  "bathroom_furniture",
  "living_room_furniture",
  "dining_room_furniture",
  "kitchen_furniture",
  "home_decor",
]);

// ─── Room type string sent to /api/gen/generate-room ─────────────────────────
// Maps UserImageCategory → room_type param expected by the backend.
// "bathroom" falls back to generic furniture behaviour on the backend.

const ROOM_TYPE_FROM_CATEGORY: Partial<Record<UserImageCategory, string>> = {
  room_bedroom:      "bedroom",
  room_living_room:  "living_room",
  room_kitchen:      "kitchen",
  room_dining_room:  "dining_room",
  room_bathroom:     "bathroom",
};

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
  dining_room_furniture:  "accessories",
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
    const isFurniture = FURNITURE_PRODUCT_TYPES.has(productType);

    if (!jobId) {
      if (abortSignal?.aborted) {
        this.bus.emit("personalization:cancelled", {});
        throw new Error("Cancelled");
      }

      const form = new FormData();
      let submitPath: string;

      if (isFurniture) {
        // ── Room generation flow ─────────────────────────────────────────────
        // POST /api/gen/generate-room
        //   room_type      — derived from user image category
        //   room_image     — room photo blob (or URL if pre-uploaded to GCS)
        //   object_url     — furniture product image URL
        const roomType = ROOM_TYPE_FROM_CATEGORY[userImageCategory] ?? "bedroom";
        form.append("room_type", roomType);
        if (userImageUrl) {
          form.append("room_image_url", userImageUrl);
        } else {
          form.append("room_image", userImage, "room.jpg");
        }
        form.append("object_url", productImageUrl);
        submitPath = ENDPOINTS.generateRoom;
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
        form.append("category", BROAD_CATEGORY[productType] ?? "accessories");

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

    // Furniture jobs use a different status path than person try-on jobs
    const statusPath = isFurniture
      ? `${ENDPOINTS.roomStatus}/${jobId}`
      : `${ENDPOINTS.status}/${jobId}`;

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

      // Furniture endpoints return JSON snapshots, not SSE events.
      if (isFurniture) {
        const pollFurnitureStatus = async () => {
          while (!settled) {
            if (abortSignal?.aborted) {
              settled = true;
              clearTimeout(timeoutHandle);
              await this.cache.clearActiveJob(activeJobKey);
              this.bus.emit("personalization:cancelled", { jobId: jobId ?? undefined });
              reject(new Error("Cancelled"));
              return;
            }

            try {
              const raw = await this.api.get(statusPath);
              const latest = Array.isArray(raw) ? raw[raw.length - 1] : raw;
              const data = (latest && typeof latest === "object" && "data" in latest)
                ? (latest as { data?: Record<string, unknown> }).data
                : null;

              const status = typeof data?.status === "string" ? data.status : undefined;
              const outputUrl = typeof data?.output_url === "string" ? data.output_url : undefined;
              const errorMessage =
                typeof data?.error === "string" && data.error.trim().length
                  ? data.error
                  : "Try-on job failed on server";

              if (status === "COMPLETED" && outputUrl) {
                settled = true;
                clearTimeout(timeoutHandle);
                const clean = `${outputUrl.split("?")[0]}?t=${Date.now()}`;
                await this.cache.setResult(cacheKey, clean, this.config.cache.resultTtlMs);
                await this.cache.clearActiveJob(activeJobKey);
                this.analytics.personalizationCompleted(jobId!, productType, false);
                this.bus.emit("personalization:completed", { imageUrl: clean, cacheHit: false, jobId: jobId! });
                resolve({ imageUrl: clean, cacheHit: false, jobId: jobId! });
                return;
              }

              if (status === "FAILED") {
                settled = true;
                clearTimeout(timeoutHandle);
                await this.cache.clearActiveJob(activeJobKey);
                reject(jobFailedError({ jobId, message: errorMessage }));
                return;
              }

              await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
            } catch (e) {
              settled = true;
              clearTimeout(timeoutHandle);
              await this.cache.clearActiveJob(activeJobKey);
              reject(normalizeError(e));
              return;
            }
          }
        };

        void pollFurnitureStatus();
        return;
      }

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
