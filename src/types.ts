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
  gennoctuaUrl?: string; // default: "https://token.gennoctua.com"
};

export type AuthConfig = ProxyAuthConfig | PublicKeyAuthConfig;

// ─── HyperPersona category ───────────────────────────────────────────────────

/** The broad category value sent to the HyperPersona /submit endpoint.
 *  Must be exactly one of these strings — HP routes the job based on this. */
export type HpCategory =
  | "clothing"
  | "footwear"
  | "eyewear"
  | "jewellery"
  | "accessories"
  | "makeup"
  | "furniture";

// ─── Product ─────────────────────────────────────────────────────────────────

/**
 * The product type label sent to HyperPersona as `product_type`.
 * Can be any string — e.g. "tops", "dresses", "co-ords", "activewear".
 * Well-known values are listed below for autocomplete; they also have automatic
 * `category` inference. For any other value, pass `category` explicitly.
 */
export type ProductType =
  // Eyewear
  | "sunglasses"
  | "eyeglasses"
  // Clothing
  | "mens_clothing"
  | "womens_clothing"
  | "kids_clothing"
  // Footwear
  | "footwear"
  // Jewellery
  | "jewellery"
  | "earrings"
  // Bags
  | "bags"
  // Makeup
  | "makeup_lipstick"
  | "makeup_foundation"
  | "makeup_mascara"
  // Furniture & decor
  | "bedroom_furniture"
  | "bathroom_furniture"
  | "living_room_furniture"
  | "dining_room_furniture"
  | "kitchen_furniture"
  | "home_decor"
  // Any custom product type (e.g. "tops", "dresses", "activewear")
  // Pass `category` explicitly when using a custom type.
  | (string & {});

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

// ─── User Gender ─────────────────────────────────────────────────────────────

/**
 * Required for all person product try-ons.
 * Tells the SDK which selected profile photo to use.
 * Ignored for furniture / room products.
 */
export type UserGender = "male" | "female" | "kid_boy" | "kid_girl";

// ─── User Image ───────────────────────────────────────────────────────────────

export type UserImageCategory =
  // ── Person (fashion) ──────────────────────────────────────────────────────
  | "male_full_body"
  | "female_full_body"
  | "kid_boy_full_body"
  | "kid_girl_full_body"
  | "male_face_closeup"
  | "female_face_closeup"
  | "kid_boy_face_closeup"
  | "kid_girl_face_closeup"
  // ── Room (furniture & home decor) ─────────────────────────────────────────
  | "room_bedroom"
  | "room_living_room"
  | "room_dining_room"
  | "room_kitchen"
  | "room_bathroom";

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

/**
 * Reason a photo was skipped or couldn't be used during profile selection.
 * Only reasons with count > 0 are included in SelectionSummary.rejectionReasons.
 *
 * - no_face_detected      — face-api found no face in the photo
 * - multiple_people       — more than one person detected (face or body level)
 * - low_gender_confidence — face found but gender was ambiguous (side profile, blurry, masked)
 * - not_front_facing      — body detected but person is turned sideways / angled away
 * - no_full_body          — facing camera but full body not visible (too cropped / far away)
 */
export type RejectionReasonCode =
  | "no_face_detected"
  | "multiple_people"
  | "low_gender_confidence"
  | "not_front_facing"
  | "no_full_body";

export type RejectionReason = {
  reason: RejectionReasonCode;
  /** Number of uploaded photos that had this rejection reason. */
  count: number;
};

export type SelectionSummary = {
  availableCategories: UserImageCategory[];
  missingCategories: UserImageCategory[];
  totalUploaded: number;
  totalSelected: number;
  /**
   * Per-reason count of why photos were skipped during profile selection.
   * Only includes reasons with count > 0.
   * Empty array when all photos were accepted, when running in furniture-only
   * mode (no face detection), or when the profile was restored from cache.
   *
   * @example
   * if (summary.rejectionReasons.find(r => r.reason === "multiple_people")) {
   *   showToast("Please upload individual photos, not group shots.");
   * }
   */
  rejectionReasons: RejectionReason[];
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

// ─── Personalization Mode ─────────────────────────────────────────────────────

/**
 * Tells the SDK what category of products the brand sells.
 * Controls which AI pipelines run during image ingestion:
 *
 * - "eyewear" | "fashion" | "footwear" | "jewellery" | "bags" | "makeup"
 *     → face detection only (room classifier never loads)
 * - "furniture"
 *     → room classifier only (face detection skipped)
 * - "all" or not provided
 *     → both pipelines run on all photos
 *
 * Pass an array when a brand sells multiple categories (e.g. Gucci sells
 * fashion + jewellery + makeup → ["fashion", "jewellery", "makeup"]).
 */
export type PersonalizationMode =
  | "eyewear"
  | "fashion"
  | "footwear"
  | "jewellery"
  | "bags"
  | "makeup"
  | "furniture"
  | "all";

// ─── SDK Config ───────────────────────────────────────────────────────────────

export type SDKConfig = {
  auth: AuthConfig;
  personalizationMode?: PersonalizationMode | PersonalizationMode[];
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

// ─── Room top-candidates (for LLM refinement) ────────────────────────────────

/**
 * A room photo candidate ready to be sent to an LLM for final verification.
 * Sorted by yoloScore descending — index 0 is the strongest YOLO detection.
 */
export type TopRoomCandidate = {
  file: File;
  hash: string;
  /** Raw YOLO inference score (sum of detected object scores). Higher = more confident. */
  yoloScore: number;
  /** Normalised confidence 0–1 */
  confidence: number;
  /** Highest-confidence detected object in the image (e.g. "bed", "couch") */
  topLabel: string;
};

/**
 * Top-5 room candidates per room type, ready to send to an LLM image picker.
 * Empty array means no images were bucketed into that room type.
 */
export type TopRoomCandidatesMap = {
  bedroom:     TopRoomCandidate[];
  living_room: TopRoomCandidate[];
  dining_room: TopRoomCandidate[];
};

// ─── Batch / Multi-product ────────────────────────────────────────────────────

export type BatchProduct = {
  productId: string;
  imageUrl: string;
  productType: ProductType;
  /** Required for person products (clothing, eyewear, footwear, etc.).
   *  Not needed for furniture — omit when category is "furniture". */
  gender?: UserGender;
  /** The broad category sent to HyperPersona. Controls job routing on the backend. */
  category: HpCategory;
};

export type BatchResult = {
  productId: string;
} & (
  | { status: "completed"; imageUrl: string; cacheHit: boolean; jobId: string }
  | { status: "failed"; error: string }
  | { status: "ineligible"; reason: string }
);
