/**
 * CDN IIFE entry point.
 * Exposes window.Personalize so the SDK can be used via a <script> tag
 * without any bundler.
 *
 * Usage:
 *   <script src="https://cdn.example.com/personalize.min.global.js"></script>
 *   <script>
 *     const sdk = await window.Personalize.init({ auth: { ... } });
 *   </script>
 */

import { PersonalizeSDK } from "./sdk.js";
import type { SDKConfig } from "./types.js";

// Injected at build time by tsup define
declare const SDK_VERSION: string;

// Export named symbols — tsup IIFE with globalName:"Personalize" wraps these
// into window.Personalize = { init, version }
export const init = (config: SDKConfig) => PersonalizeSDK.init(config);
export const version = (typeof SDK_VERSION !== "undefined" ? SDK_VERSION : "0.1.0") as string;
