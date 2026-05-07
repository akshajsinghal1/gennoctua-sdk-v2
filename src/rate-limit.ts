import { rateLimitedError } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

export class RateLimitService {
  private config: ResolvedConfig["rateLimit"];

  // Per-session counters
  private personalizationSessionCount = 0;
  private taggingSessionCount = 0;

  // Per-product counters
  private personalizationPerProduct: Map<string, number> = new Map();

  // Cooldown tracking
  private lastPersonalizationAt = 0;
  private lastTaggingAt = 0;

  // In-flight single-flight registry: productKey → Promise
  private inFlightPersonalizations: Map<string, Promise<unknown>> = new Map();

  constructor(config: ResolvedConfig["rateLimit"]) {
    this.config = config;
  }

  // ── Personalization ─────────────────────────────────────────────────────────

  checkPersonalization(productKey: string): void {
    const cfg = this.config.personalization;
    if (!cfg?.enabled) return;

    const now = Date.now();

    if (cfg.cooldownMs && now - this.lastPersonalizationAt < cfg.cooldownMs) {
      throw rateLimitedError();
    }

    if (cfg.maxPerSession && this.personalizationSessionCount >= cfg.maxPerSession) {
      throw rateLimitedError();
    }

    const productCount = this.personalizationPerProduct.get(productKey) ?? 0;
    if (cfg.maxPerProduct && productCount >= cfg.maxPerProduct) {
      throw rateLimitedError();
    }
  }

  recordPersonalization(productKey: string): void {
    this.lastPersonalizationAt = Date.now();
    this.personalizationSessionCount++;
    this.personalizationPerProduct.set(
      productKey,
      (this.personalizationPerProduct.get(productKey) ?? 0) + 1,
    );
  }

  /**
   * Single-flight: if a personalization for productKey is already in progress,
   * return the same promise instead of creating a new request.
   */
  getInFlight<T>(productKey: string): Promise<T> | null {
    return (this.inFlightPersonalizations.get(productKey) as Promise<T>) ?? null;
  }

  registerInFlight<T>(productKey: string, promise: Promise<T>): Promise<T> {
    this.inFlightPersonalizations.set(productKey, promise as Promise<unknown>);
    promise.finally(() => {
      this.inFlightPersonalizations.delete(productKey);
    });
    return promise;
  }

  // ── Tagging ─────────────────────────────────────────────────────────────────

  checkTagging(): void {
    const cfg = this.config.tagging;
    if (!cfg?.enabled) return;

    const now = Date.now();

    if (cfg.cooldownMs && now - this.lastTaggingAt < cfg.cooldownMs) {
      throw rateLimitedError();
    }

    if (cfg.maxPerSession && this.taggingSessionCount >= cfg.maxPerSession) {
      throw rateLimitedError();
    }
  }

  recordTagging(): void {
    this.lastTaggingAt = Date.now();
    this.taggingSessionCount++;
  }

  // ── Reset ────────────────────────────────────────────────────────────────────

  reset(): void {
    this.personalizationSessionCount = 0;
    this.taggingSessionCount = 0;
    this.personalizationPerProduct.clear();
    this.lastPersonalizationAt = 0;
    this.lastTaggingAt = 0;
    this.inFlightPersonalizations.clear();
  }
}
