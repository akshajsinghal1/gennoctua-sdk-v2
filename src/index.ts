// Main entry points
export { Personalize, PersonalizeSDK } from "./sdk.js";

// Types
export type {
  SDKConfig,
  AuthConfig,
  PersonalizationMode,
  ProductConfig,
  ProductRule,
  ProductType,
  HpCategory,
  ProductContext,
  ProductImageContext,
  ProductImageSource,
  UserImageCategory,
  UserGender,
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
  TopRoomCandidate,
  TopRoomCandidatesMap,
} from "./types.js";

// Errors
export { SDKError } from "./errors.js";
export type { SDKErrorCode } from "./errors.js";

// Selection progress (useful for progress UI)
export type { SelectionProgress } from "./selection.js";

// Room classifier — exposed for advanced use (e.g. show room type detection in UI)
export type { RoomType, RoomClassification } from "./room-classifier.js";
export { classifyRoom, resetRoomClassifier, DEFAULT_ROOM_MODEL_URL } from "./room-classifier.js";

// Debug
export type { DebugState } from "./debug.js";
