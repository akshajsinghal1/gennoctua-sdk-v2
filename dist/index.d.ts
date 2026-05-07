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
type ProductType = "sunglasses" | "eyeglasses" | "mens_clothing" | "womens_clothing" | "kids_clothing" | "footwear" | "jewellery" | "earrings" | "bags" | "makeup_lipstick" | "makeup_foundation" | "makeup_mascara" | "bedroom_furniture" | "bathroom_furniture" | "living_room_furniture" | "kitchen_furniture" | "home_decor";
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
 * v1: fashion categories only.
 * Phase 2 will add: "bedroom" | "bathroom" | "living_room" | "kitchen"
 */
type UserImageCategory = "male_full_body" | "female_full_body" | "child_full_body" | "male_face_closeup" | "female_face_closeup" | "child_face_closeup";
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
type SelectionSummary = {
    availableCategories: UserImageCategory[];
    missingCategories: UserImageCategory[];
    totalUploaded: number;
    totalSelected: number;
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
type SDKConfig = {
    auth: AuthConfig;
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
type BatchProduct = {
    productId: string;
    imageUrl: string;
    productType: ProductType;
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
 * LocalSelectionService
 *
 * Wraps the existing browser AI pipeline (face-api.js + MediaPipe PoseLandmarker)
 * to produce SelectedImageAsset[] from a FileList.
 *
 * Models load lazily from CDN on first call.
 * All logic is adapted from the battle-tested MauiJim pipeline.
 */

type SelectionProgress = {
    phase: "loading_models" | "categorizing" | "ranking" | "complete";
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
    private constructor();
    static init(config: SDKConfig): Promise<PersonalizeSDK>;
    ingestImages(fileList: FileList | null | undefined, onProgress?: (p: SelectionProgress) => void): Promise<SelectionSummary>;
    resolveProduct(overrides?: {
        imageUrl?: string;
        productType?: ProductType;
        productId?: string;
        productTitle?: string;
    }): Promise<ProductContext>;
    getEligibility(productType?: ProductType): Promise<EligibilityResult>;
    personalize(overrides?: {
        imageUrl?: string;
        productType?: ProductType;
        productId?: string;
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
        clearSelection: () => Promise<void>;
        clearPersonalization: () => Promise<void>;
        clearAll: () => Promise<void>;
    };
    on<K extends SDKEventName>(event: K, handler: (payload: SDKEventMap[K]) => void): () => void;
    off<K extends SDKEventName>(event: K, handler: (payload: SDKEventMap[K]) => void): void;
    debug: {
        getState: () => DebugState;
    };
    cancel(): void;
    reset(): void;
}
declare const Personalize: {
    init: typeof PersonalizeSDK.init;
};

export { type AnalyticsConfig, type AnalyticsEvent, type AuthConfig, type BatchProduct, type BatchResult, type CacheConfig, type DebugState, type EligibilityResult, type PersonalizationResult, type PersonalizationState, Personalize, PersonalizeSDK, type ProductConfig, type ProductContext, type ProductImageContext, type ProductImageSource, type ProductRule, type ProductType, type RateLimitConfig, type SDKConfig, SDKError, type SDKErrorCode, type SDKEventMap, type SDKEventName, type SelectedImageAsset, type SelectionProgress, type SelectionSummary, type UserImageCategory, type ViewMode };
