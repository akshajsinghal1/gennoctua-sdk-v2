export type SDKErrorCode =
  | "AUTH_INVALID"
  | "AUTH_DOMAIN_NOT_ALLOWED"
  | "CONFIG_INVALID"
  | "PRODUCT_CONTEXT_NOT_FOUND"
  | "PRODUCT_TYPE_NOT_FOUND"
  | "REQUIRED_USER_IMAGE_MISSING"
  | "UPLOAD_FAILED"
  | "SELECTION_FAILED"
  | "TAGGING_FAILED"
  | "RATE_LIMITED_CLIENT"
  | "RATE_LIMITED_SERVER"
  | "PERSONALIZATION_JOB_FAILED"
  | "PERSONALIZATION_JOB_TIMEOUT"
  | "PERSONALIZATION_CANCELLED"
  | "NETWORK_ERROR"
  | "CACHE_ERROR"
  | "UNSUPPORTED_BROWSER";

export class SDKError extends Error {
  readonly code: SDKErrorCode;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(opts: {
    code: SDKErrorCode;
    message: string;
    recoverable: boolean;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = "SDKError";
    this.code = opts.code;
    this.recoverable = opts.recoverable;
    this.details = opts.details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function networkError(message: string, details?: Record<string, unknown>): SDKError {
  return new SDKError({ code: "NETWORK_ERROR", message, recoverable: true, details });
}

export function authError(message: string, code: "AUTH_INVALID" | "AUTH_DOMAIN_NOT_ALLOWED" = "AUTH_INVALID"): SDKError {
  return new SDKError({ code, message, recoverable: false });
}

export function configError(message: string, details?: Record<string, unknown>): SDKError {
  return new SDKError({ code: "CONFIG_INVALID", message, recoverable: false, details });
}

export function rateLimitedError(): SDKError {
  return new SDKError({
    code: "RATE_LIMITED_CLIENT",
    message: "Request blocked by client-side rate limit. Please wait before trying again.",
    recoverable: true,
  });
}

export function jobTimeoutError(attempts: number): SDKError {
  return new SDKError({
    code: "PERSONALIZATION_JOB_TIMEOUT",
    message: `Personalization timed out after ${attempts} polling attempts.`,
    recoverable: true,
    details: { attempts },
  });
}

export function jobFailedError(details?: Record<string, unknown>): SDKError {
  return new SDKError({
    code: "PERSONALIZATION_JOB_FAILED",
    message: "Personalization job failed on the server.",
    recoverable: true,
    details,
  });
}

export function missingUserImageError(requiredCategory: string, available: string[]): SDKError {
  return new SDKError({
    code: "REQUIRED_USER_IMAGE_MISSING",
    message: `Required image category "${requiredCategory}" not found in uploaded photos.`,
    recoverable: true,
    details: { requiredCategory, availableCategories: available },
  });
}

export function cacheError(message: string): SDKError {
  return new SDKError({ code: "CACHE_ERROR", message, recoverable: true });
}

export function normalizeError(e: unknown): SDKError {
  if (e instanceof SDKError) return e;
  const message = e instanceof Error ? e.message : String(e);
  // Detect network-level errors
  if (message.toLowerCase().includes("network") || message.toLowerCase().includes("fetch")) {
    return networkError(message);
  }
  return new SDKError({ code: "NETWORK_ERROR", message, recoverable: true });
}
