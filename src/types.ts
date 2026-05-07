// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Full-stack auth mode.
 * Brand's own backend generates the JWT and proxies to HyperPersona.
 */
export type ProxyAuthConfig = {
  proxyUrl: string;
  getToken: () => Promise<string> | string;
};

/**
 * Frontend-only auth mode.
 * Gennoctua backend generates the JWT and proxies to HyperPersona.
 * SDK auto-exchanges the publicKey for a short-lived JWT.
 */
export type PublicKeyAuthConfig = {
  publicKey: string;
  gennoctuaUrl?: string; // default: "https://ec.gennoctua.com"
};

export type AuthConfig = ProxyAuthConfig | PublicKeyAuthConfig;

// ─── Product ─────────────────────────────────────────────────────────────────

export type ProductType =
  // Eyewear
  | "sunglasses"
  | "eyeglasses"
  // Clothing
  | "mens_clothing"
  | "womens_clothing"
  | "kids_clothing"
  // Footwear (gender-aware routing handled internally)
  | "footwear"
  // Jewellery
  | "jewellery"        // → necklace_pendants
  | "earrings"         // → earrings
  // Bags
  | "bags"
  // Makeup
  | "makeup_lipstick"
  | "makeup_foundation"
  | "makeup_mascara"
  // Furniture & decor (generic path)
  | "bedroom_furniture"
  | "bathroom_furniture"
  | "living_room_furniture"
  | "kitchen_furniture"
  | "home_decor";

export type ProductImageSource =
  | "manual"
  | "selector"
  | "structured_data"
  | "platform_adapter"
  | "dom_heuristic";

export type ProductImageContext = {
  imageUrl: string;
  source: ProductImageSource;
  confidence: number;
  width?: number;
  height?: number;
};

export type ProductContext = {
  image: ProductImageContext;
  productType: ProductType;
  productTypeSource: "manual" | "config_rule" | "auto_detect";
  productId?: string;
  productTitle?: string;
  pageUrl?: string;
};

// ─── User Image ───────────────────────────────────────────────────────────────

/**
 * v1: fashion categories only.
 * Phase 2 will add: "bedroom" | "bathroom" | "living_room" | "kitchen"
 */
export type UserImageCategory =
  | "male_full_body"
  | "female_full_body"
  | "child_full_body"
  | "male_face_closeup"
  | "female_face_closeup"
  | "child_face_closeup";

export type SelectedImageAsset = {
  category: UserImageCategory;
  imageId: string;
  blob: Blob;
  hash: string;
  confidence: number;
  qualityScore: number;
  source: "local_ai" | "backend_tagging" | "merged";
  createdAt: string;
};

export type SelectionSummary = {
  availableCategories: UserImageCategory[];
  missingCategories: UserImageCategory[];
  totalUploaded: number;
  totalSelected: number;
};

// ─── Eligibility ──────────────────────────────────────────────────────────────

export type EligibilityResult =
  | { eligible: true; productType: ProductType; requiredCategory: UserImageCategory }
  | {
      eligible: false;
      reason:
        | "REQUIRED_USER_IMAGE_MISSING"
        | "PRODUCT_CONTEXT_NOT_FOUND"
        | "PRODUCT_TYPE_NOT_FOUND"
        | "PRODUCT_TYPE_UNSUPPORTED";
      productType?: ProductType;
      requiredCategory?: UserImageCategory;
      availableCategories: UserImageCategory[];
    };

// ─── Personalization ──────────────────────────────────────────────────────────

export type PersonalizationState =
  | "idle"
  | "selection_missing"
  | "eligible"
  | "cache_checking"
  | "cache_hit"
  | "creating_job"
  | "queued"
  | "running"
  | "personalized"
  | "failed"
  | "timeout"
  | "cancelled";

export type PersonalizationResult = {
  imageUrl: string;
  cacheHit: boolean;
  jobId: string;
};

export type ViewMode = "original" | "personalized";

// ─── Rate Limiting ────────────────────────────────────────────────────────────

export type RateLimitConfig = {
  personalization?: {
    enabled?: boolean;
    cooldownMs?: number;
    maxPerSession?: number;
    maxPerProduct?: number;
    singleFlight?: boolean;
  };
  tagging?: {
    enabled?: boolean;
    cooldownMs?: number;
    maxPerSession?: number;
  };
};

// ─── Product Config ───────────────────────────────────────────────────────────

export type ProductRule = {
  match: {
    urlPattern?: string;
    titleContains?: string;
    categoryContains?: string;
  };
  productType: ProductType;
};

export type ProductConfig = {
  imageSelector?: string;
  gallerySelector?: string;
  productType?: ProductType;
  rules?: ProductRule[];
  detectFromStructuredData?: boolean;
  detectFromDom?: boolean;
};

// ─── Cache Config ─────────────────────────────────────────────────────────────

export type CacheConfig = {
  resultTtlMs?: number;       // default: 7 days
  selectionTtlMs?: number;    // default: 24 hours
  restoreActiveJobs?: boolean; // default: true — resume polling after refresh
  activeJobMaxAgeMs?: number;  // default: 5 min — don't restore jobs older than this
};

// ─── Analytics ────────────────────────────────────────────────────────────────

export type AnalyticsEvent = {
  eventName: string;
  orgId: string;
  sessionId: string;
  anonymousUserId: string;
  timestamp: string;
  product?: {
    productId?: string;
    productType?: ProductType;
    productImageHash?: string;
    pageUrl?: string;
  };
  personalization?: {
    jobId?: string;
    cacheHit?: boolean;
    status?: string;
  };
  metadata?: Record<string, unknown>;
};

export type AnalyticsConfig = {
  enabled?: boolean;
  onEvent?: (event: AnalyticsEvent) => void;
};

// ─── SDK Config ───────────────────────────────────────────────────────────────

export type SDKConfig = {
  auth: AuthConfig;
  product?: ProductConfig;
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
  analytics?: AnalyticsConfig;
  debug?: boolean;
  maxImages?: number;           // default: 80
  pollIntervalMs?: number;      // default: 1500
  pollMaxAttempts?: number;     // default: 120
};

// ─── SDK Events ───────────────────────────────────────────────────────────────

export type SDKEventMap = {
  // Upload + Selection
  "upload:started": { fileCount: number };
  "upload:completed": { fileCount: number; validCount: number };
  "upload:failed": { error: string };
  "selection:started": { fileCount: number };
  "selection:completed": SelectionSummary;
  "selection:failed": { error: string };

  // Product context
  "product:resolved": ProductContext;
  "product:failed": { error: string };

  // Eligibility
  "eligibility:eligible": EligibilityResult & { eligible: true };
  "eligibility:ineligible": EligibilityResult & { eligible: false };

  // Personalization lifecycle
  "personalization:requested": { productImageUrl: string };
  "personalization:cache_hit": PersonalizationResult;
  "personalization:job_created": { jobId: string };
  "personalization:polling_started": { jobId: string };
  "personalization:completed": PersonalizationResult;
  "personalization:failed": { error: string; code: string };
  "personalization:cancelled": { jobId?: string };
  "personalization:rate_limited": { reason: string };

  // Rendering
  "view:changed": { mode: ViewMode };

  // Errors
  "error": import("./errors.js").SDKError;
};

export type SDKEventName = keyof SDKEventMap;

// ─── Batch / Multi-product ────────────────────────────────────────────────────

export type BatchProduct = {
  productId: string;
  imageUrl: string;
  productType: ProductType;
};

export type BatchResult = {
  productId: string;
} & (
  | { status: "completed"; imageUrl: string; cacheHit: boolean; jobId: string }
  | { status: "failed"; error: string }
  | { status: "ineligible"; reason: string }
);
