import type { ResolvedConfig } from "./config.js";
import type { AnalyticsEvent, ProductType } from "./types.js";

export class AnalyticsService {
  private config: ResolvedConfig["analytics"];
  private orgId: string;
  private sessionId: string;
  private anonymousUserId: string;

  constructor(config: ResolvedConfig["analytics"], orgId: string, sessionId: string) {
    this.config = config;
    this.orgId = orgId;
    this.sessionId = sessionId;
    this.anonymousUserId = getOrCreateAnonymousId();
  }

  emit(
    eventName: string,
    extra?: {
      product?: AnalyticsEvent["product"];
      personalization?: AnalyticsEvent["personalization"];
      metadata?: Record<string, unknown>;
    },
  ): void {
    if (!this.config.enabled) return;

    const event: AnalyticsEvent = {
      eventName,
      orgId: this.orgId,
      sessionId: this.sessionId,
      anonymousUserId: this.anonymousUserId,
      timestamp: new Date().toISOString(),
      ...extra,
    };

    // Forward to merchant callback — never throw
    try {
      this.config.onEvent?.(event);
    } catch (e) {
      console.warn("[personalize-sdk] onEvent callback threw:", e);
    }

    // Internal analytics endpoint — v1: no-op, add endpoint in future
    // void this.sendInternal(event);
  }

  // Convenience wrappers for common events
  uploadStarted(fileCount: number): void {
    this.emit("upload_started", { metadata: { fileCount } });
  }

  uploadCompleted(fileCount: number, validCount: number): void {
    this.emit("upload_completed", { metadata: { fileCount, validCount } });
  }

  selectionCompleted(totalUploaded: number, totalSelected: number, categories: string[]): void {
    this.emit("selection_completed", {
      metadata: { totalUploaded, totalSelected, categories },
    });
  }

  personalizationRequested(productImageUrl: string, productType: ProductType): void {
    this.emit("personalization_requested", {
      product: { productType, pageUrl: typeof window !== "undefined" ? window.location.href : undefined },
      metadata: { productImageUrl },
    });
  }

  personalizationCacheHit(jobId: string, productType: ProductType): void {
    this.emit("personalization_cache_hit", {
      product: { productType },
      personalization: { jobId, cacheHit: true, status: "completed" },
    });
  }

  personalizationJobCreated(jobId: string): void {
    this.emit("personalization_job_created", {
      personalization: { jobId, status: "queued" },
    });
  }

  personalizationCompleted(jobId: string, productType: ProductType, cacheHit: boolean): void {
    this.emit("personalization_completed", {
      product: { productType },
      personalization: { jobId, cacheHit, status: "completed" },
    });
  }

  personalizationFailed(error: string, code: string): void {
    this.emit("personalization_failed", { metadata: { error, code } });
  }

  rateLimitedClient(): void {
    this.emit("personalization_rate_limited_client");
  }

  viewChanged(mode: string): void {
    this.emit(mode === "personalized" ? "personalized_viewed" : "original_viewed_after_personalization");
  }
}

// ─── Anonymous user ID ────────────────────────────────────────────────────────

function getOrCreateAnonymousId(): string {
  const KEY = "gennoctua_anon_id";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = `anon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return `anon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
