import { configError } from "./errors.js";
import type { SDKConfig } from "./types.js";

const DEFAULT_MAX_IMAGES = 80;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_MAX_ATTEMPTS = 120;
const DEFAULT_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days
const DEFAULT_SELECTION_TTL_MS = 24 * 60 * 60 * 1000;      // 24 hours
const DEFAULT_ACTIVE_JOB_MAX_AGE_MS = 5 * 60 * 1000;       // 5 minutes

export type ResolvedConfig = Required<
  Omit<SDKConfig, "auth" | "product" | "cache" | "rateLimit" | "analytics">
> & {
  auth: SDKConfig["auth"];
  product: NonNullable<SDKConfig["product"]>;
  cache: {
    resultTtlMs: number;
    selectionTtlMs: number;
    restoreActiveJobs: boolean;
    activeJobMaxAgeMs: number;
  };
  rateLimit: NonNullable<SDKConfig["rateLimit"]>;
  analytics: NonNullable<SDKConfig["analytics"]>;
};

export function resolveConfig(config: SDKConfig): ResolvedConfig {
  validateConfig(config);

  return {
    auth: config.auth,
    product: {
      detectFromStructuredData: true,
      detectFromDom: true,
      ...config.product,
    },
    cache: {
      resultTtlMs: config.cache?.resultTtlMs ?? DEFAULT_RESULT_TTL_MS,
      selectionTtlMs: config.cache?.selectionTtlMs ?? DEFAULT_SELECTION_TTL_MS,
      restoreActiveJobs: config.cache?.restoreActiveJobs ?? true,
      activeJobMaxAgeMs: config.cache?.activeJobMaxAgeMs ?? DEFAULT_ACTIVE_JOB_MAX_AGE_MS,
    },
    rateLimit: {
      personalization: {
        enabled: true,
        cooldownMs: 10_000,
        maxPerSession: 20,
        maxPerProduct: 3,
        singleFlight: true,
        ...config.rateLimit?.personalization,
      },
      tagging: {
        enabled: true,
        cooldownMs: 5_000,
        maxPerSession: 5,
        ...config.rateLimit?.tagging,
      },
    },
    analytics: {
      enabled: true,
      ...config.analytics,
    },
    debug: config.debug ?? false,
    maxImages: config.maxImages ?? DEFAULT_MAX_IMAGES,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollMaxAttempts: config.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS,
  };
}

function validateConfig(config: SDKConfig): void {
  if (!config) {
    throw configError("SDK config is required.");
  }
  if (!config.auth) {
    throw configError("auth config is required.");
  }

  // Full-stack mode
  if ("proxyUrl" in config.auth) {
    if (!config.auth.proxyUrl?.trim()) {
      throw configError("auth.proxyUrl is required.");
    }
    if (typeof config.auth.getToken !== "function") {
      throw configError("auth.getToken must be a function that returns a session token.");
    }
    return;
  }

  // Frontend-only mode
  if ("publicKey" in config.auth) {
    if (!config.auth.publicKey?.trim()) {
      throw configError("auth.publicKey is required.");
    }
    return;
  }

  throw configError("auth must have either proxyUrl+getToken (full-stack) or publicKey (frontend-only).");
}

/**
 * Derives a stable org identifier for use in cache keys.
 * Full-stack: derived from proxyUrl hostname.
 * Frontend-only: derived from publicKey.
 */
export function getOrgId(config: ResolvedConfig): string {
  const auth = config.auth;

  if ("proxyUrl" in auth) {
    try {
      const url = new URL(auth.proxyUrl);
      return url.hostname.replace(/\./g, "_").slice(0, 32);
    } catch {
      return auth.proxyUrl.slice(0, 32).replace(/[^a-zA-Z0-9]/g, "_");
    }
  }

  // publicKey mode — use key suffix as org id
  const key = auth.publicKey;
  const idx = key.indexOf("_pk_");
  return idx !== -1 ? key.slice(idx + 4, idx + 20) : key.slice(0, 16);
}
