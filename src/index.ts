// Main entry points
export { Personalize, PersonalizeSDK } from "./sdk.js";

// Types
export type {
  SDKConfig,
  AuthConfig,
  ProductConfig,
  ProductRule,
  ProductType,
  ProductContext,
  ProductImageContext,
  ProductImageSource,
  UserImageCategory,
  SelectedImageAsset,
  SelectionSummary,
  EligibilityResult,
  PersonalizationState,
  PersonalizationResult,
  ViewMode,
  RateLimitConfig,
  CacheConfig,
  AnalyticsConfig,
  AnalyticsEvent,
  SDKEventName,
  SDKEventMap,
  BatchProduct,
  BatchResult,
} from "./types.js";

// Errors
export { SDKError } from "./errors.js";
export type { SDKErrorCode } from "./errors.js";

// Selection progress (useful for progress UI)
export type { SelectionProgress } from "./selection.js";

// Debug
export type { DebugState } from "./debug.js";
