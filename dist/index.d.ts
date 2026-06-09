type SDKErrorCode = "AUTH_INVALID" | "AUTH_DOMAIN_NOT_ALLOWED" | "CONFIG_INVALID" | "PRODUCT_CONTEXT_NOT_FOUND" | "PRODUCT_TYPE_NOT_FOUND" | "REQUIRED_USER_IMAGE_MISSING" | "UPLOAD_FAILED" | "SELECTION_FAILED" | "TAGGING_FAILED" | "RATE_LIMITED_CLIENT" | "RATE_LIMITED_SERVER" | "PERSONALIZATION_JOB_FAILED" | "PERSONALIZATION_JOB_TIMEOUT" | "PERSONALIZATION_CANCELLED" | "NETWORK_ERROR" | "CACHE_ERROR" | "UNSUPPORTED_BROWSER";
declare class SDKError extends Error {
    readonly code: SDKErrorCode;
    readonly recoverable: boolean;
    readonly details?: Record<string, unknown>;
    constructor(opts: {
        code: SDKErrorCode;
        message: string;
        recoverable: boolean;
        details?: Record<string, unknown>;
    });
    toJSON(): {
        code: SDKErrorCode;
        message: string;
        recoverable: boolean;
        details: Record<string, unknown> | undefined;
    };
}

/**
 * Full-stack auth mode.
 * Brand's own backend generates the JWT and proxies to HyperPersona.
 */
type ProxyAuthConfig = {
    proxyUrl: string;
    getToken: () => Promise<string> | string;
};
/**
 * Frontend-only auth mode.
 * Gennoctua backend generates the JWT and proxies to HyperPersona.
 * SDK auto-exchanges the publicKey for a short-lived JWT.
 */
type PublicKeyAuthConfig = {
    publicKey: string;
    gennoctuaUrl?: string;
};
type AuthConfig = ProxyAuthConfig | PublicKeyAuthConfig;
/** The broad category value sent to the HyperPersona /submit endpoint.
 *  Must be exactly one of these strings — HP routes the job based on this. */
type HpCategory = "clothing" | "footwear" | "eyewear" | "jewellery" | "accessories" | "makeup" | "furniture";
/**
 * The product type label sent to HyperPersona as `product_type`.
 * Can be any string — e.g. "tops", "dresses", "co-ords", "activewear".
 * Well-known values are listed below for autocomplete; they also have automatic
 * `category` inference. For any other value, pass `category` explicitly.
 */
type ProductType = "sunglasses" | "eyeglasses" | "mens_clothing" | "womens_clothing" | "kids_clothing" | "footwear" | "jewellery" | "earrings" | "bags" | "makeup_lipstick" | "makeup_foundation" | "makeup_mascara" | "bedroom_furniture" | "bathroom_furniture" | "living_room_furniture" | "dining_room_furniture" | "kitchen_furniture" | "home_decor" | (string & {});
type ProductImageSource = "manual" | "selector" | "structured_data" | "platform_adapter" | "dom_heuristic";
type ProductImageContext = {
    imageUrl: string;
    source: ProductImageSource;
    confidence: number;
    width?: number;
    height?: number;
};
type ProductContext = {
    image: ProductImageContext;
    productType: ProductType;
    productTypeSource: "manual" | "config_rule" | "auto_detect";
    productId?: string;
    productTitle?: string;
    pageUrl?: string;
};
/**
 * Required for all person product try-ons.
 * Tells the SDK which selected profile photo to use.
 * Ignored for furniture / room products.
 */
type UserGender = "male" | "female" | "kid_boy" | "kid_girl";
type UserImageCategory = "male_full_body" | "female_full_body" | "kid_boy_full_body" | "kid_girl_full_body" | "male_face_closeup" | "female_face_closeup" | "kid_boy_face_closeup" | "kid_girl_face_closeup" | "room_bedroom" | "room_living_room" | "room_dining_room" | "room_kitchen" | "room_bathroom";
type SelectedImageAsset = {
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
type RejectionReasonCode = "no_face_detected" | "multiple_people" | "low_gender_confidence" | "not_front_facing" | "no_full_body";
type RejectionReason = {
    reason: RejectionReasonCode;
    /** Number of uploaded photos that had this rejection reason. */
    count: number;
};
type SelectionSummary = {
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
type EligibilityResult = {
    eligible: true;
    productType: ProductType;
    requiredCategory: UserImageCategory;
} | {
    eligible: false;
    reason: "REQUIRED_USER_IMAGE_MISSING" | "PRODUCT_CONTEXT_NOT_FOUND" | "PRODUCT_TYPE_NOT_FOUND" | "PRODUCT_TYPE_UNSUPPORTED";
    productType?: ProductType;
    requiredCategory?: UserImageCategory;
    availableCategories: UserImageCategory[];
};
type PersonalizationState = "idle" | "selection_missing" | "eligible" | "cache_checking" | "cache_hit" | "creating_job" | "queued" | "running" | "personalized" | "failed" | "timeout" | "cancelled";
type PersonalizationResult = {
    imageUrl: string;
    cacheHit: boolean;
    jobId: string;
};
type ViewMode = "original" | "personalized";
type RateLimitConfig = {
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
type ProductRule = {
    match: {
        urlPattern?: string;
        titleContains?: string;
        categoryContains?: string;
    };
    productType: ProductType;
};
type ProductConfig = {
    imageSelector?: string;
    gallerySelector?: string;
    productType?: ProductType;
    rules?: ProductRule[];
    detectFromStructuredData?: boolean;
    detectFromDom?: boolean;
};
type CacheConfig = {
    resultTtlMs?: number;
    selectionTtlMs?: number;
    restoreActiveJobs?: boolean;
    activeJobMaxAgeMs?: number;
};
type AnalyticsEvent = {
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
type AnalyticsConfig = {
    enabled?: boolean;
    onEvent?: (event: AnalyticsEvent) => void;
};
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
type PersonalizationMode = "eyewear" | "fashion" | "footwear" | "jewellery" | "bags" | "makeup" | "furniture" | "all";
type SDKConfig = {
    auth: AuthConfig;
    personalizationMode?: PersonalizationMode | PersonalizationMode[];
    product?: ProductConfig;
    cache?: CacheConfig;
    rateLimit?: RateLimitConfig;
    analytics?: AnalyticsConfig;
    debug?: boolean;
    maxImages?: number;
    pollIntervalMs?: number;
    pollMaxAttempts?: number;
};
type SDKEventMap = {
    "upload:started": {
        fileCount: number;
    };
    "upload:completed": {
        fileCount: number;
        validCount: number;
    };
    "upload:failed": {
        error: string;
    };
    "selection:started": {
        fileCount: number;
    };
    "selection:completed": SelectionSummary;
    "selection:failed": {
        error: string;
    };
    "product:resolved": ProductContext;
    "product:failed": {
        error: string;
    };
    "eligibility:eligible": EligibilityResult & {
        eligible: true;
    };
    "eligibility:ineligible": EligibilityResult & {
        eligible: false;
    };
    "personalization:requested": {
        productImageUrl: string;
    };
    "personalization:cache_hit": PersonalizationResult;
    "personalization:job_created": {
        jobId: string;
    };
    "personalization:polling_started": {
        jobId: string;
    };
    "personalization:completed": PersonalizationResult;
    "personalization:failed": {
        error: string;
        code: string;
    };
    "personalization:cancelled": {
        jobId?: string;
    };
    "personalization:rate_limited": {
        reason: string;
    };
    "view:changed": {
        mode: ViewMode;
    };
    "error": SDKError;
};
type SDKEventName = keyof SDKEventMap;
/**
 * A room photo candidate ready to be sent to an LLM for final verification.
 * Sorted by yoloScore descending — index 0 is the strongest YOLO detection.
 */
type TopRoomCandidate = {
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
type TopRoomCandidatesMap = {
    bedroom: TopRoomCandidate[];
    living_room: TopRoomCandidate[];
    dining_room: TopRoomCandidate[];
};
type BatchProduct = {
    productId: string;
    imageUrl: string;
    productType: ProductType;
    /** Required for person products (clothing, eyewear, footwear, etc.).
     *  Not needed for furniture — omit when category is "furniture". */
    gender?: UserGender;
    /** The broad category sent to HyperPersona. Controls job routing on the backend. */
    category: HpCategory;
};
type BatchResult = {
    productId: string;
} & ({
    status: "completed";
    imageUrl: string;
    cacheHit: boolean;
    jobId: string;
} | {
    status: "failed";
    error: string;
} | {
    status: "ineligible";
    reason: string;
});

type DebugState = {
    product: {
        context: ProductContext | null;
        imageSource: string | null;
        typeSource: string | null;
    };
    selection: {
        summary: SelectionSummary | null;
        availableCategories: string[];
        missingRequiredCategory: string | null;
    };
    eligibility: EligibilityResult | null;
    personalization: {
        state: PersonalizationState;
        activeJobId: string | null;
        cacheKey: string | null;
        lastError: string | null;
    };
    view: {
        mode: ViewMode;
    };
    rateLimit: {
        personalizationSessionCount: number;
        lastPersonalizationAt: number | null;
    };
};

/**
 * selection.ts — v2
 *
 * Improvements over v1:
 * - Front-facing detection (computeFrontFacingDiagnostic, 8-component weighted score)
 * - Proper standing rank: full_body_standing(1) > knee_visible(2) > upper_body(3) > sitting variants
 * - Separate selection logic for full_body (pose-first) vs face_closeup (face clarity-first)
 * - kid_boy / kid_girl are distinct profiles (kid_boy_full_body, kid_boy_face_closeup, etc.)
 * - iOS safe mode: sequential processing instead of parallel
 * - Single-person validation: rejects multi-person frames
 *
 * Models load lazily from CDN on first call (singleton pattern).
 */

type SelectionProgress = {
    phase: "loading_models" | "categorizing" | "scoring" | "ranking" | "complete";
    message: string;
    current?: number;
    total?: number;
};

declare class PersonalizeSDK {
    private config;
    private bus;
    private auth;
    private api;
    private cacheService;
    private rateLimit;
    private analytics;
    private dbg;
    private productCtx;
    private personalizationSvc;
    private taggingSvc;
    private orgId;
    private sessionId;
    private selectedAssets;
    private selectionSummary;
    private currentProductContext;
    private viewMode;
    private activeAbortController;
    /** GCS URLs keyed by asset hash — populated in background after ingestImages() */
    private profileUrlCache;
    private constructor();
    static init(config: SDKConfig): Promise<PersonalizeSDK>;
    ingestImages(fileList: FileList | null | undefined, onProgress?: (p: SelectionProgress) => void): Promise<SelectionSummary>;
    /**
     * Restore a previously selected profile from cache.
     * Call this on page load — if a cached profile exists, the user can skip
     * the upload step entirely and go straight to personalization.
     *
     * Returns the SelectionSummary if a valid cached profile was found,
     * or null if no cache exists / cache has expired.
     */
    restoreProfile(): Promise<SelectionSummary | null>;
    resolveProduct(overrides?: {
        imageUrl?: string;
        productType?: ProductType;
        productId?: string;
        productTitle?: string;
    }): Promise<ProductContext>;
    getEligibility(productType?: ProductType): Promise<EligibilityResult>;
    personalize(opts: {
        imageUrl: string;
        productType: ProductType;
        /** Required for person products (clothing, eyewear, footwear, etc.).
         *  Not needed when category is "furniture". */
        gender?: UserGender;
        /** The broad category sent to HyperPersona. Controls job routing on the backend. */
        category: HpCategory;
        productId?: string;
        abortSignal?: AbortSignal;
    }): Promise<PersonalizationResult>;
    personalizeAll(products: BatchProduct[], onResult?: (result: BatchResult) => void): Promise<BatchResult[]>;
    view: {
        showOriginal: () => void;
        showPersonalized: () => void;
        toggle: () => void;
        getMode: () => ViewMode;
    };
    selection: {
        getSummary: () => SelectionSummary | null;
        getAssets: () => SelectedImageAsset[];
    };
    product: {
        getContext: () => ProductContext | null;
        refreshContext: (overrides?: Parameters<PersonalizeSDK["resolveProduct"]>[0]) => Promise<ProductContext>;
    };
    cache: {
        clearProfile: () => Promise<void>;
        clearSelection: () => Promise<void>;
        clearPersonalization: () => Promise<void>;
        clearAll: () => Promise<void>;
    };
    on<K extends SDKEventName>(event: K, handler: (payload: SDKEventMap[K]) => void): () => void;
    off<K extends SDKEventName>(event: K, handler: (payload: SDKEventMap[K]) => void): void;
    debug: {
        getState: () => DebugState;
    };
    /**
     * Upload each unique selected asset to GCS in the background.
     * When a product submission fires later, profileUrlCache will already have
     * the URL — so we send user_image_url instead of re-uploading the blob.
     * Silent on failure: personalize() falls back to raw blob upload.
     */
    private uploadProfilesInBackground;
    /**
     * Optionally refine the local-AI selection using the Gennoctua LLM picker.
     * Compresses top-5 candidates per category to 512px, sends to /api/profile/select,
     * and swaps out any asset where the LLM found a better pick.
     * Falls back silently to the original assets on any error or timeout.
     */
    private refineSelectionWithLLM;
    /**
     * Optionally refine the YOLO room selection using the Gennoctua LLM room picker.
     * Compresses top-5 candidates per room type to 512px, sends to /api/room/select,
     * and swaps out any asset where the LLM found a better pick.
     * Falls back silently to the original YOLO picks on any error or timeout.
     */
    private refineRoomsWithLLM;
    cancel(): void;
    reset(): void;
}
declare const Personalize: {
    init: typeof PersonalizeSDK.init;
};

/**
 * room-classifier.ts — YOLOv11n ONNX object-detection room classifier
 *
 * Ports the Android SDK RoomInference.infer() scoring logic to the web.
 *
 * Scoring rules (tuned against real home photo dataset):
 *   "bed"          → bedroom      (+2.0, +3.0 if conf > 50%)
 *   "couch"        → living_room  (+2.0 if area ≥ 8%, else +1.5)
 *                    only when couchConf > 0.40 (below that it's likely a misdetected bed)
 *   "tv"           → living_room  (+1.5)
 *   "chair"        → living_room  (+0.8) when no dining table / chairs-only-dining
 *                  → dining_room  (+0.5) when dining table present OR chairs-only-dining
 *   "dining table" → dining_room  (+2.0 if area ≥ 8%, +1.0 if area ≥ 3%)
 *                    skipped when dominant couch present (coffee-table FP guard)
 *                    skipped in open-plan rooms where couch + table both > 0.40
 *
 * Anti-false-positive rules:
 *   1. couch conf > bed conf × 0.95 AND couch conf > 0.40
 *      AND couch area > bed area + 0.05 → bedroomScore = 0
 *      (sofa misread as bed; area guard preserves real bed+couch bedroom shots)
 *   2. TV detected AND bed conf < 0.32 → bedroomScore = 0
 *      (low-conf bed overriding a strong TV signal)
 *   3. Sub-threshold bed (conf 0.05–0.15) with no other furniture detected AND
 *      raw couch score > 0.02 → treat as living room
 *      (boucle/curved sofa misread as a bed at very low confidence)
 *
 * Chairs-only dining: 2+ high-conf chairs (≥0.50) with no couch or TV → route
 * chairs to dining_room even without a detected dining table.
 *
 * Minimum score of 1.5 required to return a classification.
 * Tie-breaking: bedroom > dining_room > living_room
 *   (dining only wins if diningScore strictly exceeds livingScore)
 *
 * Model: YOLOv11n ONNX (~10 MB)
 *   Input  "images":  [1, 3, 640, 640] float32  (RGB, values 0..1, no ImageNet norm)
 *   Output "output0": [1, 84, 8400]    float32  (4 box coords + 80 COCO class scores)
 */
/** YOLOv11n ONNX hosted on Gennoctua GCS (~10 MB) */
declare const DEFAULT_ROOM_MODEL_URL = "https://storage.googleapis.com/gennoctua/yolo11n.onnx";
type RoomType = "bedroom" | "living_room" | "dining_room" | "kitchen" | "bathroom" | "other";
type RoomClassification = {
    roomType: RoomType;
    /** Normalised confidence 0–1 (derived from YOLO score 0–4+) */
    confidence: number;
    /** Raw YOLO inference score (sum of object scores). Use for ranking candidates. */
    yoloScore: number;
    /** true when a known room type was detected above the minimum score threshold */
    isRoom: boolean;
    /** Highest-confidence detected object label (e.g. "bed", "couch") */
    label: string;
};
/** Reset singleton — forces reload on next call (e.g. to swap model URLs). */
declare function resetRoomClassifier(): void;
/**
 * Classify a room image using YOLOv8n object detection + RoomInference scoring.
 *
 * Returns `{ roomType: "other", isRoom: false, yoloScore: 0 }` on any error
 * or when no furniture is detected above threshold.
 * ONNX Runtime + model are loaded lazily on the first call (singleton).
 */
declare function classifyRoom(file: File, modelUrl?: string): Promise<RoomClassification>;

export { type AnalyticsConfig, type AnalyticsEvent, type AuthConfig, type BatchProduct, type BatchResult, type CacheConfig, DEFAULT_ROOM_MODEL_URL, type DebugState, type EligibilityResult, type HpCategory, type PersonalizationMode, type PersonalizationResult, type PersonalizationState, Personalize, PersonalizeSDK, type ProductConfig, type ProductContext, type ProductImageContext, type ProductImageSource, type ProductRule, type ProductType, type RateLimitConfig, type RejectionReason, type RejectionReasonCode, type RoomClassification, type RoomType, type SDKConfig, SDKError, type SDKErrorCode, type SDKEventMap, type SDKEventName, type SelectedImageAsset, type SelectionProgress, type SelectionSummary, type TopRoomCandidate, type TopRoomCandidatesMap, type UserGender, type UserImageCategory, type ViewMode, classifyRoom, resetRoomClassifier };
