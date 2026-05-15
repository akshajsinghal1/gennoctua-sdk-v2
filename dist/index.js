import { ApiClient, normalizeError, cacheError, rateLimitedError, SDKError, jobFailedError, jobTimeoutError, configError } from './chunk-YYLNIUP2.js';
export { SDKError } from './chunk-YYLNIUP2.js';

// src/config.ts
var DEFAULT_MAX_IMAGES = 80;
var DEFAULT_POLL_INTERVAL_MS = 1500;
var DEFAULT_POLL_MAX_ATTEMPTS = 120;
var DEFAULT_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var DEFAULT_SELECTION_TTL_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_ACTIVE_JOB_MAX_AGE_MS = 5 * 60 * 1e3;
function resolveConfig(config) {
  validateConfig(config);
  return {
    auth: config.auth,
    personalizationMode: resolvePersonalizationMode(config.personalizationMode),
    product: {
      detectFromStructuredData: true,
      detectFromDom: true,
      ...config.product
    },
    cache: {
      resultTtlMs: config.cache?.resultTtlMs ?? DEFAULT_RESULT_TTL_MS,
      selectionTtlMs: config.cache?.selectionTtlMs ?? DEFAULT_SELECTION_TTL_MS,
      restoreActiveJobs: config.cache?.restoreActiveJobs ?? true,
      activeJobMaxAgeMs: config.cache?.activeJobMaxAgeMs ?? DEFAULT_ACTIVE_JOB_MAX_AGE_MS
    },
    rateLimit: {
      personalization: {
        enabled: true,
        cooldownMs: 1e4,
        maxPerSession: 20,
        maxPerProduct: 3,
        singleFlight: true,
        ...config.rateLimit?.personalization
      },
      tagging: {
        enabled: true,
        cooldownMs: 5e3,
        maxPerSession: 5,
        ...config.rateLimit?.tagging
      }
    },
    analytics: {
      enabled: true,
      ...config.analytics
    },
    debug: config.debug ?? false,
    maxImages: config.maxImages ?? DEFAULT_MAX_IMAGES,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollMaxAttempts: config.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS
  };
}
function resolvePersonalizationMode(mode) {
  if (!mode) return ["all"];
  if (Array.isArray(mode)) return mode.length > 0 ? mode : ["all"];
  return [mode];
}
function validateConfig(config) {
  if (!config) {
    throw configError("SDK config is required.");
  }
  if (!config.auth) {
    throw configError("auth config is required.");
  }
  if ("proxyUrl" in config.auth) {
    if (!config.auth.proxyUrl?.trim()) {
      throw configError("auth.proxyUrl is required.");
    }
    if (typeof config.auth.getToken !== "function") {
      throw configError("auth.getToken must be a function that returns a session token.");
    }
    return;
  }
  if ("publicKey" in config.auth) {
    if (!config.auth.publicKey?.trim()) {
      throw configError("auth.publicKey is required.");
    }
    return;
  }
  throw configError("auth must have either proxyUrl+getToken (full-stack) or publicKey (frontend-only).");
}
function getOrgId(config) {
  const auth = config.auth;
  if ("proxyUrl" in auth) {
    try {
      const url = new URL(auth.proxyUrl);
      return url.hostname.replace(/\./g, "_").slice(0, 32);
    } catch {
      return auth.proxyUrl.slice(0, 32).replace(/[^a-zA-Z0-9]/g, "_");
    }
  }
  const key = auth.publicKey;
  const idx = key.indexOf("_pk_");
  return idx !== -1 ? key.slice(idx + 4, idx + 20) : key.slice(0, 16);
}

// src/auth.ts
var DEFAULT_GENNOCTUA_URL = "https://token.gennoctua.com";
var TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1e3;
var AuthService = class {
  constructor(config) {
    // PublicKey mode — cached token state
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
    this.config = config;
  }
  async getHeaders() {
    const token = await this.resolveToken();
    return {
      "Authorization": `Bearer ${token}`,
      "X-SDK-Version": "0.1.0"
    };
  }
  getProxyUrl() {
    const auth = this.config.auth;
    if ("proxyUrl" in auth) {
      return auth.proxyUrl;
    }
    return (auth.gennoctuaUrl ?? DEFAULT_GENNOCTUA_URL) + "/api/tryon";
  }
  // ── Token resolution ────────────────────────────────────────────────────────
  async resolveToken() {
    const auth = this.config.auth;
    if ("getToken" in auth) {
      return await auth.getToken();
    }
    return this.getPublicKeyToken(auth.publicKey, auth.gennoctuaUrl ?? DEFAULT_GENNOCTUA_URL);
  }
  async getPublicKeyToken(publicKey, gennoctuaUrl) {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.cachedToken;
    }
    const res = await fetch(`${gennoctuaUrl}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey })
    });
    if (!res.ok) {
      throw new Error(`Failed to get token from Gennoctua: HTTP ${res.status}`);
    }
    const data = await res.json();
    this.cachedToken = data.token;
    this.tokenExpiresAt = Date.now() + data.expiresIn * 1e3;
    return this.cachedToken;
  }
};

// src/cache.ts
var DB_NAME = "gennoctua_personalize_v1";
var DB_VERSION = 1;
var STORE = {
  selected_images: "selected_images",
  personalized_results: "personalized_results",
  active_jobs: "active_jobs",
  sdk_metadata: "sdk_metadata"
};
var CacheService = class {
  constructor() {
    this.db = null;
    this.dbPromise = null;
    this.memoryFallback = /* @__PURE__ */ new Map();
    this.useMemoryOnly = false;
  }
  // ── Open ────────────────────────────────────────────────────────────────────
  open() {
    if (this.db) return Promise.resolve(this.db);
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not available"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const name of Object.values(STORE)) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "key" });
          }
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise.catch((e) => {
      this.useMemoryOnly = true;
      console.warn("[personalize-sdk] IndexedDB unavailable, using memory cache:", e);
      return null;
    });
  }
  // ── Generic IDB helpers ─────────────────────────────────────────────────────
  async idbGet(store, key) {
    if (this.useMemoryOnly) {
      return this.memoryFallback.get(`${store}:${key}`) ?? null;
    }
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(cacheError(`IDB get failed: ${req.error?.message}`));
    });
  }
  async idbPut(store, record) {
    if (this.useMemoryOnly) {
      this.memoryFallback.set(`${store}:${record.key}`, record);
      return;
    }
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(cacheError(`IDB put failed: ${req.error?.message}`));
    });
  }
  async idbDelete(store, key) {
    if (this.useMemoryOnly) {
      this.memoryFallback.delete(`${store}:${key}`);
      return;
    }
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(cacheError(`IDB delete failed: ${req.error?.message}`));
    });
  }
  async idbClearStore(store) {
    if (this.useMemoryOnly) {
      for (const k of this.memoryFallback.keys()) {
        if (k.startsWith(`${store}:`)) this.memoryFallback.delete(k);
      }
      return;
    }
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(cacheError(`IDB clear failed: ${req.error?.message}`));
    });
  }
  // ── Selected images ─────────────────────────────────────────────────────────
  selectedKey(orgId, profileId) {
    return `${orgId}:${profileId}`;
  }
  async getSelectedImages(orgId, profileId) {
    const record = await this.idbGet(
      STORE.selected_images,
      this.selectedKey(orgId, profileId)
    );
    if (!record) return null;
    if (Date.now() - record.cachedAt > record.ttlMs) {
      await this.idbDelete(STORE.selected_images, record.key);
      return null;
    }
    return record.assets;
  }
  async setSelectedImages(orgId, profileId, assets, ttlMs) {
    await this.idbPut(STORE.selected_images, {
      key: this.selectedKey(orgId, profileId),
      assets,
      cachedAt: Date.now(),
      ttlMs
    });
  }
  // ── Personalized results ────────────────────────────────────────────────────
  resultKey(orgId, userImageHash, productImageHash, productType) {
    return `${orgId}:${userImageHash}:${productImageHash}:${productType}`;
  }
  async getResult(key) {
    const record = await this.idbGet(STORE.personalized_results, key);
    if (!record) return null;
    if (Date.now() - record.cachedAt > record.ttlMs) {
      await this.idbDelete(STORE.personalized_results, key);
      return null;
    }
    return record.imageUrl;
  }
  async setResult(key, imageUrl, ttlMs) {
    await this.idbPut(STORE.personalized_results, {
      key,
      imageUrl,
      cachedAt: Date.now(),
      ttlMs
    });
  }
  // ── Active jobs (for restoration after page refresh) ────────────────────────
  activeJobKey(orgId, resultKey) {
    return `${orgId}:${resultKey}`;
  }
  async getActiveJob(key) {
    const record = await this.idbGet(STORE.active_jobs, key);
    if (!record) return null;
    return { jobId: record.jobId, startedAt: record.startedAt };
  }
  async setActiveJob(key, jobId) {
    await this.idbPut(STORE.active_jobs, { key, jobId, startedAt: Date.now() });
  }
  async clearActiveJob(key) {
    await this.idbDelete(STORE.active_jobs, key);
  }
  // ── Profile cache ───────────────────────────────────────────────────────────
  // Persists selected assets (blobs stored natively in IndexedDB — no base64
  // conversion needed) + GCS URLs so returning users skip the AI pipeline.
  profileKey(orgId) {
    return `${orgId}:profile`;
  }
  async saveProfile(orgId, assets, profileUrls, ttlMs) {
    await this.idbPut(STORE.selected_images, {
      key: this.profileKey(orgId),
      assets,
      profileUrls,
      cachedAt: Date.now(),
      ttlMs
    });
  }
  async loadProfile(orgId) {
    const record = await this.idbGet(
      STORE.selected_images,
      this.profileKey(orgId)
    );
    if (!record) return null;
    if (Date.now() - record.cachedAt > record.ttlMs) {
      await this.idbDelete(STORE.selected_images, record.key);
      return null;
    }
    return { assets: record.assets, profileUrls: record.profileUrls ?? {} };
  }
  /**
   * Patch GCS URLs into an existing profile record without rewriting the blobs.
   * Called incrementally as background uploads complete.
   */
  async updateProfileUrls(orgId, profileUrls) {
    const record = await this.idbGet(
      STORE.selected_images,
      this.profileKey(orgId)
    );
    if (!record) return;
    await this.idbPut(STORE.selected_images, {
      ...record,
      profileUrls: { ...record.profileUrls, ...profileUrls }
    });
  }
  async clearProfile(orgId) {
    await this.idbDelete(STORE.selected_images, this.profileKey(orgId));
  }
  // ── Public clear APIs ───────────────────────────────────────────────────────
  async clearSelection() {
    await this.idbClearStore(STORE.selected_images);
  }
  async clearPersonalization() {
    await Promise.all([
      this.idbClearStore(STORE.personalized_results),
      this.idbClearStore(STORE.active_jobs)
    ]);
  }
  async clearAll() {
    await Promise.all(Object.values(STORE).map((s) => this.idbClearStore(s)));
  }
};

// src/rate-limit.ts
var RateLimitService = class {
  constructor(config) {
    // Per-session counters
    this.personalizationSessionCount = 0;
    this.taggingSessionCount = 0;
    // Per-product counters
    this.personalizationPerProduct = /* @__PURE__ */ new Map();
    // Cooldown tracking
    this.lastPersonalizationAt = 0;
    this.lastTaggingAt = 0;
    // In-flight single-flight registry: productKey → Promise
    this.inFlightPersonalizations = /* @__PURE__ */ new Map();
    this.config = config;
  }
  // ── Personalization ─────────────────────────────────────────────────────────
  checkPersonalization(productKey) {
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
  recordPersonalization(productKey) {
    this.lastPersonalizationAt = Date.now();
    this.personalizationSessionCount++;
    this.personalizationPerProduct.set(
      productKey,
      (this.personalizationPerProduct.get(productKey) ?? 0) + 1
    );
  }
  /**
   * Single-flight: if a personalization for productKey is already in progress,
   * return the same promise instead of creating a new request.
   */
  getInFlight(productKey) {
    return this.inFlightPersonalizations.get(productKey) ?? null;
  }
  registerInFlight(productKey, promise) {
    this.inFlightPersonalizations.set(productKey, promise);
    promise.finally(() => {
      this.inFlightPersonalizations.delete(productKey);
    });
    return promise;
  }
  // ── Tagging ─────────────────────────────────────────────────────────────────
  checkTagging() {
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
  recordTagging() {
    this.lastTaggingAt = Date.now();
    this.taggingSessionCount++;
  }
  // ── Reset ────────────────────────────────────────────────────────────────────
  reset() {
    this.personalizationSessionCount = 0;
    this.taggingSessionCount = 0;
    this.personalizationPerProduct.clear();
    this.lastPersonalizationAt = 0;
    this.lastTaggingAt = 0;
    this.inFlightPersonalizations.clear();
  }
};

// src/analytics.ts
var AnalyticsService = class {
  constructor(config, orgId, sessionId) {
    this.config = config;
    this.orgId = orgId;
    this.sessionId = sessionId;
    this.anonymousUserId = getOrCreateAnonymousId();
  }
  emit(eventName, extra) {
    if (!this.config.enabled) return;
    const event = {
      eventName,
      orgId: this.orgId,
      sessionId: this.sessionId,
      anonymousUserId: this.anonymousUserId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ...extra
    };
    try {
      this.config.onEvent?.(event);
    } catch (e) {
      console.warn("[personalize-sdk] onEvent callback threw:", e);
    }
  }
  // Convenience wrappers for common events
  uploadStarted(fileCount) {
    this.emit("upload_started", { metadata: { fileCount } });
  }
  uploadCompleted(fileCount, validCount) {
    this.emit("upload_completed", { metadata: { fileCount, validCount } });
  }
  selectionCompleted(totalUploaded, totalSelected, categories) {
    this.emit("selection_completed", {
      metadata: { totalUploaded, totalSelected, categories }
    });
  }
  personalizationRequested(productImageUrl, productType) {
    this.emit("personalization_requested", {
      product: { productType, pageUrl: typeof window !== "undefined" ? window.location.href : void 0 },
      metadata: { productImageUrl }
    });
  }
  personalizationCacheHit(jobId, productType) {
    this.emit("personalization_cache_hit", {
      product: { productType },
      personalization: { jobId, cacheHit: true, status: "completed" }
    });
  }
  personalizationJobCreated(jobId) {
    this.emit("personalization_job_created", {
      personalization: { jobId, status: "queued" }
    });
  }
  personalizationCompleted(jobId, productType, cacheHit) {
    this.emit("personalization_completed", {
      product: { productType },
      personalization: { jobId, cacheHit, status: "completed" }
    });
  }
  personalizationFailed(error, code) {
    this.emit("personalization_failed", { metadata: { error, code } });
  }
  rateLimitedClient() {
    this.emit("personalization_rate_limited_client");
  }
  viewChanged(mode) {
    this.emit(mode === "personalized" ? "personalized_viewed" : "original_viewed_after_personalization");
  }
};
function getOrCreateAnonymousId() {
  const KEY = "gennoctua_anon_id";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = `anon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return `anon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

// src/event-bus.ts
var EventBus = class {
  constructor() {
    this.listeners = {};
  }
  on(event, handler) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(handler);
    return () => this.off(event, handler);
  }
  off(event, handler) {
    const arr = this.listeners[event];
    if (!arr) return;
    const idx = arr.indexOf(handler);
    if (idx !== -1) arr.splice(idx, 1);
  }
  emit(event, payload) {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const handler of [...arr]) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[personalize-sdk] Unhandled error in "${event}" listener:`, e);
      }
    }
  }
  removeAll() {
    this.listeners = {};
  }
};

// src/debug.ts
var DebugService = class {
  constructor(enabled) {
    this.state = {
      product: { context: null, imageSource: null, typeSource: null },
      selection: { summary: null, availableCategories: [], missingRequiredCategory: null },
      eligibility: null,
      personalization: { state: "idle", activeJobId: null, cacheKey: null, lastError: null },
      view: { mode: "original" },
      rateLimit: { personalizationSessionCount: 0, lastPersonalizationAt: null }
    };
    this.enabled = enabled;
  }
  getState() {
    return structuredClone(this.state);
  }
  setProductContext(ctx) {
    this.state.product.context = ctx;
    this.state.product.imageSource = ctx?.image.source ?? null;
    this.state.product.typeSource = ctx?.productTypeSource ?? null;
    if (this.enabled) {
      console.info("[personalize-sdk:debug] product_context", ctx);
    }
  }
  setSelectionSummary(summary, missingRequired) {
    this.state.selection.summary = summary;
    this.state.selection.availableCategories = summary?.availableCategories ?? [];
    this.state.selection.missingRequiredCategory = missingRequired;
    if (this.enabled) {
      console.info("[personalize-sdk:debug] selection_summary", summary);
    }
  }
  setEligibility(result) {
    this.state.eligibility = result;
    if (this.enabled) {
      console.info("[personalize-sdk:debug] eligibility", result);
    }
  }
  setPersonalizationState(state, jobId, error) {
    this.state.personalization.state = state;
    if (jobId !== void 0) this.state.personalization.activeJobId = jobId;
    if (error !== void 0) this.state.personalization.lastError = error;
    if (this.enabled) {
      console.info(`[personalize-sdk:debug] personalization_state=${state}`, { jobId, error });
    }
  }
  setViewMode(mode) {
    this.state.view.mode = mode;
    if (this.enabled) {
      console.info(`[personalize-sdk:debug] view_mode=${mode}`);
    }
  }
  log(label, data) {
    if (!this.enabled) return;
    console.info(`[personalize-sdk:debug] ${label}`, data ?? "");
  }
};

// src/product-context.ts
var ProductContextService = class {
  constructor(config, api) {
    this.config = config;
    this.api = api;
  }
  async getContext(overrides) {
    const image = await this.resolveProductImage(overrides?.imageUrl);
    if (!image) {
      throw new SDKError({
        code: "PRODUCT_CONTEXT_NOT_FOUND",
        message: "Could not resolve a product image. Configure product.imageSelector or pass imageUrl directly.",
        recoverable: false
      });
    }
    let { productType, source: typeSource } = this.resolveProductTypeLocal(overrides?.productType);
    if (!productType) {
      const title = overrides?.productTitle ?? this.detectProductTitle() ?? void 0;
      const description = this.detectPageDescription() ?? void 0;
      const detected = await this.detectProductTypeRemote(image.imageUrl, title, description);
      if (detected) {
        productType = detected;
        typeSource = "auto_detect";
      }
    }
    if (!productType) {
      throw new SDKError({
        code: "PRODUCT_TYPE_NOT_FOUND",
        message: "Could not detect product type. Pass productType manually or set product.rules in config.",
        recoverable: false
      });
    }
    return {
      image,
      productType,
      productTypeSource: typeSource,
      productId: overrides?.productId,
      productTitle: overrides?.productTitle ?? this.detectProductTitle() ?? void 0,
      pageUrl: typeof window !== "undefined" ? window.location.href : void 0
    };
  }
  // ── Product image resolution ────────────────────────────────────────────────
  async resolveProductImage(manualUrl) {
    if (manualUrl) {
      return { imageUrl: manualUrl, source: "manual", confidence: 1 };
    }
    if (this.config.imageSelector) {
      const url = this.extractImageFromSelector(this.config.imageSelector);
      if (url) return { imageUrl: url, source: "selector", confidence: 0.95 };
    }
    if (this.config.detectFromStructuredData) {
      const url = this.extractFromStructuredData();
      if (url) return { imageUrl: url, source: "structured_data", confidence: 0.9 };
    }
    if (this.config.detectFromDom) {
      const url = this.extractFromDomHeuristic();
      if (url) return { imageUrl: url, source: "dom_heuristic", confidence: 0.6 };
    }
    return null;
  }
  extractImageFromSelector(selector) {
    try {
      const el = document.querySelector(selector);
      if (!el) return null;
      if (el instanceof HTMLImageElement) return el.src || el.getAttribute("data-src") || null;
      const img = el.querySelector("img");
      return img?.src || img?.getAttribute("data-src") || null;
    } catch {
      return null;
    }
  }
  extractFromStructuredData() {
    try {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        const data = JSON.parse(script.textContent || "");
        const type = data["@type"];
        if (type === "Product" || Array.isArray(type) && type.includes("Product")) {
          const image = data.image;
          if (typeof image === "string") return image;
          if (Array.isArray(image) && typeof image[0] === "string") return image[0];
          if (typeof image?.url === "string") return image.url;
        }
      }
    } catch {
    }
    return null;
  }
  extractFromDomHeuristic() {
    const selectors = [
      ".product__image img",
      ".product-image img",
      ".product-photo img",
      "[data-product-image] img",
      ".pdp-image img",
      'img[itemprop="image"]',
      '.gallery__image img[src*="product"]'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el?.src) return el.src;
      } catch {
      }
    }
    return null;
  }
  // ── Product type resolution (local) ────────────────────────────────────────
  resolveProductTypeLocal(manualType) {
    if (manualType) return { productType: manualType, source: "manual" };
    if (this.config.productType) return { productType: this.config.productType, source: "manual" };
    if (this.config.rules?.length) {
      const matched = this.matchRules();
      if (matched) return { productType: matched, source: "config_rule" };
    }
    const detected = this.detectFromPage();
    if (detected) return { productType: detected, source: "auto_detect" };
    return { productType: null, source: "auto_detect" };
  }
  matchRules() {
    if (!this.config.rules) return null;
    const url = typeof window !== "undefined" ? window.location.href : "";
    const title = this.detectProductTitle()?.toLowerCase() ?? "";
    for (const rule of this.config.rules) {
      const { match, productType } = rule;
      if (match.urlPattern && !new RegExp(match.urlPattern).test(url)) continue;
      if (match.titleContains && !title.includes(match.titleContains.toLowerCase())) continue;
      return productType;
    }
    return null;
  }
  detectFromPage() {
    const text = [
      typeof window !== "undefined" ? window.location.href : "",
      document.title,
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? ""
    ].join(" ").toLowerCase();
    if (/sunglass|eyewear|eyeglasses|optical/.test(text)) return "sunglasses";
    if (/women.*dress|women.*shirt|womens.*cloth/.test(text)) return "womens_clothing";
    if (/men.*shirt|mens.*cloth|menswear/.test(text)) return "mens_clothing";
    if (/kids.*cloth|children.*wear|boys.*girls/.test(text)) return "kids_clothing";
    if (/sneaker|shoe|boot|footwear/.test(text)) return "footwear";
    if (/handbag|purse|tote bag|shoulder bag/.test(text)) return "bags";
    if (/ring|necklace|bracelet|earring|jewel/.test(text)) return "jewellery";
    if (/bedroom|mattress|bed frame/.test(text)) return "bedroom_furniture";
    if (/sofa|couch|living room/.test(text)) return "living_room_furniture";
    return null;
  }
  // ── Product type resolution (remote LLM fallback) ──────────────────────────
  /**
   * Optional remote product-type detector (POST .../api/detect-product-type on your proxy).
   * Silently returns null on any failure — never breaks the pipeline.
   */
  async detectProductTypeRemote(imageUrl, title, description) {
    try {
      const body = await this.api.post("/api/detect-product-type", {
        imageUrl,
        title,
        description
      });
      if (body?.productType && body.confident !== false) {
        return body.productType;
      }
      return null;
    } catch {
      return null;
    }
  }
  // ── Page metadata helpers ───────────────────────────────────────────────────
  detectProductTitle() {
    return document.querySelector("h1")?.textContent?.trim() ?? document.querySelector('meta[property="og:title"]')?.content ?? null;
  }
  detectPageDescription() {
    return document.querySelector('meta[name="description"]')?.content ?? document.querySelector('meta[property="og:description"]')?.content ?? null;
  }
  // ── SPA support ─────────────────────────────────────────────────────────────
  async refreshContext(overrides) {
    return this.getContext(overrides);
  }
};

// src/personalization.ts
var FURNITURE_PRODUCT_TYPES = /* @__PURE__ */ new Set([
  "bedroom_furniture",
  "bathroom_furniture",
  "living_room_furniture",
  "dining_room_furniture",
  "kitchen_furniture",
  "home_decor"
]);
var POSE_TAG_FROM_CATEGORY = {
  male_full_body: "1",
  female_full_body: "1",
  kid_boy_full_body: "1",
  kid_girl_full_body: "1",
  male_face_closeup: "3",
  female_face_closeup: "3",
  kid_boy_face_closeup: "3",
  kid_girl_face_closeup: "3"
  // room_* categories intentionally omitted — no pose concept for furniture
};
var BROAD_CATEGORY = {
  sunglasses: "eyewear",
  eyeglasses: "eyewear",
  mens_clothing: "clothing",
  womens_clothing: "clothing",
  kids_clothing: "clothing",
  footwear: "footwear",
  jewellery: "jewellery",
  earrings: "jewellery",
  bags: "accessories",
  makeup_lipstick: "makeup",
  makeup_foundation: "makeup",
  makeup_mascara: "makeup",
  bedroom_furniture: "furniture",
  bathroom_furniture: "furniture",
  living_room_furniture: "furniture",
  dining_room_furniture: "furniture",
  kitchen_furniture: "furniture",
  home_decor: "furniture"
};
var PRODUCT_TYPE_LABEL = {
  sunglasses: "sunglasses",
  eyeglasses: "eyeglasses",
  mens_clothing: "mens clothing",
  womens_clothing: "womens clothing",
  kids_clothing: "kids clothing",
  footwear: "footwear",
  jewellery: "jewellery necklace",
  earrings: "earrings",
  bags: "bag",
  makeup_lipstick: "lipstick",
  makeup_foundation: "foundation",
  makeup_mascara: "mascara",
  bedroom_furniture: "bedroom furniture",
  bathroom_furniture: "bathroom furniture",
  living_room_furniture: "living room furniture",
  dining_room_furniture: "dining room furniture",
  kitchen_furniture: "kitchen furniture",
  home_decor: "home decor"
};
var PersonalizationService = class {
  constructor(api, cache, config, analytics, bus, orgId) {
    this.api = api;
    this.cache = cache;
    this.config = config;
    this.analytics = analytics;
    this.bus = bus;
    this.orgId = orgId;
  }
  async personalize(opts) {
    const {
      userImage,
      userImageUrl,
      userImageHash,
      userImageCategory,
      productImageUrl,
      productImageHash,
      productType,
      abortSignal
    } = opts;
    const cacheKey = this.cache.resultKey(
      this.orgId,
      userImageHash,
      productImageHash,
      productType
    );
    const cached = await this.cache.getResult(cacheKey);
    if (cached) {
      this.analytics.personalizationCacheHit(cacheKey, productType);
      this.bus.emit("personalization:cache_hit", { imageUrl: cached, cacheHit: true, jobId: cacheKey });
      return { imageUrl: cached, cacheHit: true, jobId: cacheKey };
    }
    this.analytics.personalizationRequested(productImageUrl, productType);
    this.bus.emit("personalization:requested", { productImageUrl });
    let jobId = null;
    const activeJobKey = this.cache.activeJobKey(this.orgId, cacheKey);
    if (this.config.cache.restoreActiveJobs) {
      const activeJob = await this.cache.getActiveJob(activeJobKey);
      if (activeJob && Date.now() - activeJob.startedAt < this.config.cache.activeJobMaxAgeMs) {
        jobId = activeJob.jobId;
        console.info(`[personalize-sdk] Restoring active job ${jobId}`);
      }
    }
    const { ENDPOINTS } = await import('./api-client-UH2EXBHR.js');
    const isFurniture = FURNITURE_PRODUCT_TYPES.has(productType);
    if (!jobId) {
      if (abortSignal?.aborted) {
        this.bus.emit("personalization:cancelled", {});
        throw new Error("Cancelled");
      }
      const form = new FormData();
      let submitPath;
      if (isFurniture) {
        form.append("user_image", userImage, "room.jpg");
        form.append("garment_image_url", productImageUrl);
        form.append("product_type", PRODUCT_TYPE_LABEL[productType] ?? productType);
        form.append("category", "furniture");
        submitPath = ENDPOINTS.submit;
      } else {
        form.append("user_image", userImage, "profile.jpg");
        form.append("garment_image_url", productImageUrl);
        form.append("product_type", PRODUCT_TYPE_LABEL[productType] ?? productType);
        form.append("category", BROAD_CATEGORY[productType] ?? "accessories");
        const poseTag = POSE_TAG_FROM_CATEGORY[userImageCategory];
        if (poseTag !== void 0) {
          form.append("tag", poseTag);
        }
        submitPath = ENDPOINTS.submit;
      }
      const body = await this.api.post(submitPath, form);
      jobId = typeof body.job_id === "string" ? body.job_id : null;
      if (!jobId) throw jobFailedError({ response: body });
      await this.cache.setActiveJob(activeJobKey, jobId);
      this.analytics.personalizationJobCreated(jobId);
      this.bus.emit("personalization:job_created", { jobId });
    }
    this.bus.emit("personalization:polling_started", { jobId });
    const statusPath = `${ENDPOINTS.status}/${jobId}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = this.config.pollIntervalMs * this.config.pollMaxAttempts;
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.cache.clearActiveJob(activeJobKey);
        reject(jobTimeoutError(this.config.pollMaxAttempts));
      }, timeoutMs);
      this.api.stream(
        statusPath,
        async (event) => {
          if (settled) return;
          const status = event.status;
          const resultUrl = event.result_url;
          if (status === "COMPLETED" && resultUrl) {
            settled = true;
            clearTimeout(timeoutHandle);
            const clean = `${resultUrl.split("?")[0]}?t=${Date.now()}`;
            await this.cache.setResult(cacheKey, clean, this.config.cache.resultTtlMs);
            await this.cache.clearActiveJob(activeJobKey);
            this.analytics.personalizationCompleted(jobId, productType, false);
            this.bus.emit("personalization:completed", { imageUrl: clean, cacheHit: false, jobId });
            resolve({ imageUrl: clean, cacheHit: false, jobId });
          }
          if (status === "FAILED") {
            settled = true;
            clearTimeout(timeoutHandle);
            await this.cache.clearActiveJob(activeJobKey);
            const message = event.message ?? "Try-on job failed on server";
            reject(jobFailedError({ jobId, message }));
          }
        },
        abortSignal
      ).catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        void this.cache.clearActiveJob(activeJobKey);
        if (e.name === "AbortError") {
          this.bus.emit("personalization:cancelled", { jobId: jobId ?? void 0 });
          reject(new Error("Cancelled"));
        } else {
          reject(normalizeError(e));
        }
      });
    });
  }
};

// src/room-classifier.ts
var ONNX_RUNTIME_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js";
var ONNX_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
var DEFAULT_ROOM_MODEL_URL = "https://storage.googleapis.com/gennoctua/yolo11n.onnx";
var FURNITURE_CLASS_MAP = {
  "chair": 56,
  "couch": 57,
  "bed": 59,
  "dining table": 60,
  "tv": 62
};
var RAW_SCORE_THRESHOLD = 0.15;
var MAX_BOXES_PER_CLASS = {
  "chair": 4,
  // dining set / lounge chairs
  "couch": 2,
  // L-shaped sectionals
  "bed": 2,
  // twin beds
  "tv": 1,
  // one TV per room
  "dining table": 1
  // one table per room
};
var CENTRE_MIN_DIST_PX = 80;
function inferRoom(detections) {
  let livingScore = 0;
  let bedroomScore = 0;
  let diningScore = 0;
  let bedConf = 0;
  let couchConf = 0;
  let topLabel = "";
  let topScore = 0;
  const hasDiningTable = detections.some((d) => d.label === "dining table");
  for (const d of detections) {
    if (d.confidence > topScore) {
      topScore = d.confidence;
      topLabel = d.label;
    }
    switch (d.label) {
      case "bed":
        bedroomScore += d.confidence > 0.5 ? 3 : 2;
        if (d.confidence > bedConf) {
          bedConf = d.confidence;
          d.areaPercentage;
        }
        break;
      case "couch":
        livingScore += d.areaPercentage >= 0.08 ? 2 : 1.5;
        if (d.confidence > couchConf) couchConf = d.confidence;
        break;
      case "tv":
        livingScore += 1.5;
        break;
      case "chair":
        if (hasDiningTable) diningScore += 0.5;
        else livingScore += 0.8;
        break;
      case "dining table":
        if (d.areaPercentage >= 0.08) diningScore += 2;
        else if (d.areaPercentage >= 0.03) diningScore += 1;
        break;
    }
  }
  if (bedroomScore > 0 && couchConf > bedConf * 0.95) {
    bedroomScore = 0;
  }
  const hasTV = detections.some((d) => d.label === "tv");
  if (bedroomScore > 0 && hasTV && bedConf < 0.32) {
    bedroomScore = 0;
  }
  const maxScore = Math.max(livingScore, bedroomScore, diningScore);
  if (maxScore < 1.5) return null;
  let room;
  if (bedroomScore === maxScore) room = "bedroom";
  else if (diningScore > livingScore) room = "dining_room";
  else room = "living_room";
  return { room, score: maxScore, topLabel };
}
var roomClassifierPromise = null;
function loadOrtScript() {
  return new Promise((resolve, reject) => {
    if (window.ort) {
      resolve();
      return;
    }
    if (document.querySelector(`script[src="${ONNX_RUNTIME_CDN}"]`)) {
      const iv = setInterval(() => {
        if (window.ort) {
          clearInterval(iv);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(iv);
        reject(new Error("ort load timeout"));
      }, 2e4);
      return;
    }
    const s = document.createElement("script");
    s.src = ONNX_RUNTIME_CDN;
    s.async = true;
    s.onload = () => setTimeout(resolve, 100);
    s.onerror = () => reject(new Error(`Failed to load ONNX Runtime: ${ONNX_RUNTIME_CDN}`));
    document.head.appendChild(s);
  });
}
function ensureRoomClassifierReady(modelUrl = DEFAULT_ROOM_MODEL_URL) {
  if (!roomClassifierPromise) {
    roomClassifierPromise = (async () => {
      await loadOrtScript();
      const ort = window.ort;
      if (!ort) throw new Error("onnxruntime-web did not expose window.ort");
      ort.env.wasm.wasmPaths = ONNX_WASM_PATH;
      const session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all"
      });
      return { ort, session };
    })();
  }
  return roomClassifierPromise;
}
function resetRoomClassifier() {
  roomClassifierPromise = null;
}
var YOLO_INPUT_SIZE = 640;
function preprocessForYolo(img, ort) {
  const S = YOLO_INPUT_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S);
  const float32 = new Float32Array(3 * S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const pi = (y * S + x) * 4;
      const ch = y * S + x;
      float32[0 * S * S + ch] = data[pi] / 255;
      float32[1 * S * S + ch] = data[pi + 1] / 255;
      float32[2 * S * S + ch] = data[pi + 2] / 255;
    }
  }
  return new ort.Tensor("float32", float32, [1, 3, S, S]);
}
function parseOutputs(outputs, outputNames) {
  const S = YOLO_INPUT_SIZE;
  const out = outputs[outputNames[0]];
  if (!out || out.type !== "float32" || out.dims[2] !== 8400) return [];
  const N = 8400;
  const data = out.data;
  const dets = [];
  for (const [label, classIdx] of Object.entries(FURNITURE_CLASS_MAP)) {
    const row = (4 + classIdx) * N;
    const maxCount = MAX_BOXES_PER_CLASS[label] ?? 1;
    const candidates = [];
    for (let b = 0; b < N; b++) {
      const s = data[row + b];
      if (s > RAW_SCORE_THRESHOLD) candidates.push({ idx: b, score: s });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const accepted = [];
    for (const { idx, score } of candidates) {
      if (accepted.length >= maxCount) break;
      const cx = data[0 * N + idx];
      const cy = data[1 * N + idx];
      const tooClose = accepted.some((a) => {
        const dx = cx - a.cx, dy = cy - a.cy;
        return Math.sqrt(dx * dx + dy * dy) < CENTRE_MIN_DIST_PX;
      });
      if (tooClose) continue;
      const w = data[2 * N + idx];
      const h = data[3 * N + idx];
      accepted.push({ cx, cy, score, area: w * h / (S * S) });
    }
    for (const { score, area } of accepted) {
      dets.push({ label, confidence: score, areaPercentage: area });
    }
  }
  return dets.sort((a, b) => b.confidence - a.confidence);
}
async function classifyRoom(file, modelUrl) {
  try {
    const { ort, session } = await ensureRoomClassifierReady(modelUrl);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      const url = URL.createObjectURL(file);
      el.onload = () => {
        URL.revokeObjectURL(url);
        resolve(el);
      };
      el.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image load failed"));
      };
      el.src = url;
    });
    const imageTensor = preprocessForYolo(img, ort);
    const feeds = {
      [session.inputNames[0]]: imageTensor
    };
    const output = await session.run(feeds);
    const detections = parseOutputs(output, session.outputNames);
    const result = inferRoom(detections);
    if (!result) {
      return {
        roomType: "other",
        confidence: 0,
        yoloScore: 0,
        isRoom: false,
        label: detections[0]?.label ?? "none"
      };
    }
    return {
      roomType: result.room,
      // Normalise raw score (typical range 1.5–6) to 0–1
      confidence: Math.min(1, result.score / 6),
      yoloScore: result.score,
      isRoom: true,
      label: result.topLabel
    };
  } catch {
    return { roomType: "other", confidence: 0, yoloScore: 0, isRoom: false, label: "error" };
  }
}

// src/selection.ts
var FACE_API_CDN = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
var FACE_MODELS_CDN = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/";
var MEDIAPIPE_TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs";
var MEDIAPIPE_TASKS_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
var POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
var MAX_IMAGES = 80;
var POSE_FRONT_FACING_MIN_SCORE = 80;
var KP_MIN_CONF = 0.16;
var KP_LOWER_MIN_CONF = 0.28;
var POSE_SHOULDER_LEVEL_MAX = 0.08;
var POSE_HIP_LEVEL_MAX = 0.08;
var POSE_CENTER_OFFSET_MAX = 0.16;
var POSE_MIN_BODY_HEIGHT = 0.46;
var POSE_MIN_SHOULDER_WIDTH = 0.12;
var ROOM_TYPE_TO_CATEGORY = {
  bedroom: "room_bedroom",
  living_room: "room_living_room",
  dining_room: "room_dining_room",
  kitchen: "room_kitchen",
  bathroom: "room_bathroom",
  other: null
};
if (typeof window !== "undefined") {
  const _orig = console.error.bind(console);
  console.error = (...args) => {
    if (String(args[0]).includes("Created TensorFlow Lite XNNPACK delegate")) return;
    _orig(...args);
  };
}
var faceApiPromise = null;
var posePromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}
function ensureFaceApiReady() {
  if (!faceApiPromise) {
    faceApiPromise = (async () => {
      await loadScript(FACE_API_CDN);
      const faceapi = window.faceapi;
      if (!faceapi) throw new Error("face-api.js did not initialize");
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_CDN),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODELS_CDN),
        faceapi.nets.ageGenderNet.loadFromUri(FACE_MODELS_CDN)
      ]);
      return faceapi;
    })();
  }
  return faceApiPromise;
}
function patchWasmStreamingForIOS() {
  if (typeof WebAssembly === "undefined") return;
  const isIOS = isIOSDevice();
  const supportsStreaming = typeof WebAssembly.compileStreaming === "function";
  if (!supportsStreaming || isIOS) {
    const wa = WebAssembly;
    wa.compileStreaming = async (source) => {
      const res = await Promise.resolve(source);
      const buf = await res.arrayBuffer();
      return WebAssembly.compile(buf);
    };
    wa.instantiateStreaming = async (source, imports) => {
      const res = await Promise.resolve(source);
      const buf = await res.arrayBuffer();
      return WebAssembly.instantiate(buf, imports);
    };
  }
}
function ensurePoseReady() {
  if (!posePromise) {
    posePromise = (async () => {
      patchWasmStreamingForIOS();
      const { FilesetResolver, PoseLandmarker } = await import(
        /* webpackIgnore: true */
        MEDIAPIPE_TASKS_URL
      );
      const resolver = await FilesetResolver.forVisionTasks(MEDIAPIPE_TASKS_WASM_URL);
      return PoseLandmarker.createFromOptions(resolver, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "CPU" },
        runningMode: "IMAGE",
        numPoses: 4,
        minPoseDetectionConfidence: 0.25,
        minPosePresenceConfidence: 0.25,
        minTrackingConfidence: 0.25
      });
    })();
  }
  return posePromise;
}
function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read ${file.name}`));
    };
    img.src = url;
  });
}
function hashFile(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}
function filterValidImages(fileList) {
  return Array.from(fileList || []).filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name)).slice(0, MAX_IMAGES);
}
function pt(kp, index) {
  const p = kp[index];
  if (!p || typeof p.visibility === "number" && p.visibility < KP_MIN_CONF) return null;
  return p;
}
function ptLower(kp, index) {
  const p = kp[index];
  if (!p || typeof p.visibility === "number" && p.visibility < KP_LOWER_MIN_CONF) return null;
  return p;
}
function computeFrontFacingDiagnostic(kp) {
  const nose = pt(kp, 0);
  const leftEar = pt(kp, 7);
  const rightEar = pt(kp, 8);
  const leftShoulder = pt(kp, 11);
  const rightShoulder = pt(kp, 12);
  const leftHip = pt(kp, 23);
  const rightHip = pt(kp, 24);
  if (!leftShoulder || !rightShoulder) {
    return { score: 0, label: "side_facing" };
  }
  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderWidthScore = Math.min(100, shoulderWidth / 0.25 * 100);
  let hipWidthScore = 50;
  if (leftHip && rightHip) {
    const hipWidth = Math.abs(leftHip.x - rightHip.x);
    hipWidthScore = Math.min(100, hipWidth / 0.18 * 100);
  }
  const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y);
  const shoulderLevelScore = Math.max(0, 100 - shoulderTilt / POSE_SHOULDER_LEVEL_MAX * 100);
  let hipLevelScore = 50;
  if (leftHip && rightHip) {
    const hipTilt = Math.abs(leftHip.y - rightHip.y);
    hipLevelScore = Math.max(0, 100 - hipTilt / POSE_HIP_LEVEL_MAX * 100);
  }
  const centerOffset = Math.abs(shoulderMidX - 0.5);
  const centerScore = Math.max(0, 100 - centerOffset / POSE_CENTER_OFFSET_MAX * 100);
  let torsoSymmetryScore = 50;
  if (leftHip && rightHip) {
    const hipMidX = (leftHip.x + rightHip.x) / 2;
    const torsoLean = Math.abs(shoulderMidX - hipMidX);
    torsoSymmetryScore = Math.max(0, 100 - torsoLean / 0.08 * 100);
  }
  const leftDist = Math.abs(leftShoulder.x - 0.5);
  const rightDist = Math.abs(rightShoulder.x - 0.5);
  const sideRatio = leftDist > rightDist ? leftDist / Math.max(rightDist, 1e-3) : rightDist / Math.max(leftDist, 1e-3);
  const widthBalanceScore = Math.max(0, 100 - (sideRatio - 1) * 100);
  let headScore = 50;
  if (nose && leftEar && rightEar) {
    const earMidX = (leftEar.x + rightEar.x) / 2;
    const earSpan = Math.abs(leftEar.x - rightEar.x);
    const noseDev = Math.abs(nose.x - earMidX);
    headScore = earSpan > 0.01 ? Math.max(0, 100 - noseDev / Math.max(earSpan * 0.3, 0.02) * 100) : 50;
  }
  const score = Math.round(
    shoulderWidthScore * 0.16 + hipWidthScore * 0.12 + shoulderLevelScore * 0.14 + hipLevelScore * 0.12 + centerScore * 0.14 + torsoSymmetryScore * 0.18 + widthBalanceScore * 0.06 + headScore * 0.08
  );
  const label = score >= POSE_FRONT_FACING_MIN_SCORE ? "front_facing" : score >= 45 ? "angled" : "side_facing";
  return { score, label };
}
function rankPoseCandidate(kp) {
  const { score: frontScore, label: frontLabel } = computeFrontFacingDiagnostic(kp);
  if (frontScore < POSE_FRONT_FACING_MIN_SCORE) {
    return { frontScore, frontLabel, poseRank: 0, poseLabel: "not_front_facing" };
  }
  const ls = pt(kp, 11);
  const rs = pt(kp, 12);
  const lh = pt(kp, 23);
  const rh = pt(kp, 24);
  if (!ls || !rs || !lh || !rh) {
    return { frontScore, frontLabel, poseRank: 0, poseLabel: "insufficient_keypoints" };
  }
  if (Math.abs(ls.x - rs.x) < POSE_MIN_SHOULDER_WIDTH) {
    return { frontScore, frontLabel, poseRank: 0, poseLabel: "shoulder_too_narrow" };
  }
  const lk = ptLower(kp, 25);
  const rk = ptLower(kp, 26);
  const la = ptLower(kp, 27);
  const ra = ptLower(kp, 28);
  const hasKnees = !!(lk && rk);
  const hasAnkles = !!(la && ra);
  const bodyTop = Math.min(ls.y, rs.y);
  const bodyBottom = hasAnkles ? Math.max(la.y, ra.y) : hasKnees ? Math.max(lk.y, rk.y) : Math.max(lh.y, rh.y);
  const bodyHeight = bodyBottom - bodyTop;
  const isStanding = bodyHeight >= POSE_MIN_BODY_HEIGHT && ls.y < lh.y && rs.y < rh.y && // shoulders above hips
  (!hasKnees || lh.y < lk.y && rh.y < rk.y);
  if (hasAnkles && isStanding) return { frontScore, frontLabel, poseRank: 1, poseLabel: "full_body_standing" };
  if (hasKnees && isStanding) return { frontScore, frontLabel, poseRank: 2, poseLabel: "knee_visible_standing" };
  if (!hasKnees && !hasAnkles) return { frontScore, frontLabel, poseRank: 3, poseLabel: "upper_body_standing" };
  if (hasAnkles) return { frontScore, frontLabel, poseRank: 4, poseLabel: "full_body_sitting" };
  if (hasKnees) return { frontScore, frontLabel, poseRank: 5, poseLabel: "knee_visible_sitting" };
  return { frontScore, frontLabel, poseRank: 3, poseLabel: "upper_body" };
}
async function getPoseAssessment(file, detector) {
  const fallback = { frontScore: 0, frontLabel: "side_facing", poseRank: 0, poseLabel: "not_detected" };
  try {
    const img = await fileToImage(file);
    const canvas = document.createElement("canvas");
    const maxSide = 1024;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return fallback;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const result = detector.detect(canvas);
    if (!result?.landmarks?.length || result.landmarks.length > 1) return fallback;
    return rankPoseCandidate(result.landmarks[0]);
  } catch {
    return fallback;
  }
}
async function selectImages(fileList, onProgress, personalizationMode) {
  const files = filterValidImages(fileList);
  if (files.length === 0) {
    throw new SDKError({
      code: "UPLOAD_FAILED",
      message: "No valid image files found.",
      recoverable: true
    });
  }
  const modes = personalizationMode ?? ["all"];
  const hasAll = modes.includes("all");
  const hasFurniture = modes.includes("furniture");
  const hasPersonMode = modes.some((m) => m !== "furniture" && m !== "all");
  const needsFaceDetection = hasAll || hasPersonMode || !hasFurniture && !hasPersonMode;
  const needsRoomClassifier = hasAll || hasFurniture;
  onProgress?.({ phase: "loading_models", message: "Loading AI models..." });
  const [faceapi, pose] = needsFaceDetection ? await Promise.all([ensureFaceApiReady(), ensurePoseReady()]) : [null, null];
  const preCandidates = [];
  if (needsFaceDetection && faceapi) {
    const faceOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.5 });
    const FACE_BATCH_SIZE = 3;
    let processed = 0;
    for (let i = 0; i < files.length; i += FACE_BATCH_SIZE) {
      const batch = files.slice(i, i + FACE_BATCH_SIZE);
      onProgress?.({
        phase: "categorizing",
        message: `Scanning faces ${processed + 1}\u2013${Math.min(processed + batch.length, files.length)} of ${files.length}...`,
        current: processed,
        total: files.length
      });
      const batchResults = await Promise.all(
        batch.map(async (file) => {
          try {
            const img = await fileToImage(file);
            const faces = await faceapi.detectAllFaces(img, faceOpts).withFaceLandmarks(true).withAgeAndGender();
            return { file, faces };
          } catch {
            return { file, faces: [] };
          }
        })
      );
      for (const { file, faces } of batchResults) {
        if (faces.length === 0) continue;
        if (faces.length !== 1) continue;
        const face = faces[0];
        const gender = face.gender === "male" || face.gender === "female" ? face.gender : null;
        if (!gender || (face.genderProbability ?? 0) < 0.7) continue;
        const box = face.detection?.box;
        const iw = face.detection?.imageWidth ?? 1;
        const ih = face.detection?.imageHeight ?? 1;
        const faceAreaRatio = box ? box.width * box.height / (iw * ih) : 0;
        preCandidates.push({
          file,
          gender,
          age: typeof face.age === "number" ? face.age : 25,
          detectionScore: face.detection?.score ?? 0.5,
          genderProbability: face.genderProbability ?? 0,
          faceAreaRatio
        });
      }
      processed += batch.length;
    }
  }
  const candidates = [];
  if (needsFaceDetection && pose) {
    for (let i = 0; i < preCandidates.length; i++) {
      onProgress?.({
        phase: "scoring",
        message: `Scoring poses ${i + 1} of ${preCandidates.length}...`,
        current: i + 1,
        total: preCandidates.length
      });
      const assessment = await getPoseAssessment(preCandidates[i].file, pose);
      candidates.push({ ...preCandidates[i], ...assessment });
    }
  }
  if (candidates.length > 0) {
    console.table(candidates.map((c) => ({
      file: c.file.name,
      gender: c.gender,
      age: Math.round(c.age),
      genderProb: +c.genderProbability.toFixed(3),
      detectionScore: +c.detectionScore.toFixed(3),
      faceAreaRatio: +c.faceAreaRatio.toFixed(4),
      frontScore: +c.frontScore.toFixed(1),
      poseLabel: c.poseLabel,
      poseRank: c.poseRank,
      passesFullBody: c.frontScore >= POSE_FRONT_FACING_MIN_SCORE && c.poseRank > 0,
      passesFaceCloseup: c.frontScore >= POSE_FRONT_FACING_MIN_SCORE
    })));
  }
  const roomCandidates = [];
  if (needsRoomClassifier) {
    onProgress?.({
      phase: "scoring",
      message: `Classifying room photos (${files.length} image${files.length > 1 ? "s" : ""})...`,
      current: 0,
      total: files.length
    });
    const roomDebugRows = [];
    for (let i = 0; i < files.length; i++) {
      const result = await classifyRoom(files[i]);
      roomDebugRows.push({
        file: files[i].name,
        roomType: result.roomType,
        isRoom: result.isRoom,
        confidence: +result.confidence.toFixed(3),
        yoloScore: +result.yoloScore.toFixed(2),
        topLabel: result.label
      });
      if (result.isRoom) {
        roomCandidates.push({
          file: files[i],
          roomType: result.roomType,
          confidence: result.confidence,
          yoloScore: result.yoloScore,
          topLabel: result.label
        });
      }
      onProgress?.({
        phase: "scoring",
        message: `Classifying room photos...`,
        current: i + 1,
        total: files.length
      });
    }
    if (roomDebugRows.length > 0) {
      console.table(roomDebugRows);
    }
  }
  const results = [];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (needsFaceDetection) {
    for (const gender of ["male", "female"]) {
      const category = gender === "male" ? "male_full_body" : "female_full_body";
      const pool = candidates.filter((c) => c.gender === gender && c.frontScore >= POSE_FRONT_FACING_MIN_SCORE && c.poseRank > 0).sort(
        (a, b) => (
          // Primary: lower rank number = better pose
          a.poseRank - b.poseRank || // Secondary: higher front score
          b.frontScore - a.frontScore || // Tertiary: higher gender confidence
          b.genderProbability - a.genderProbability
        )
      );
      if (pool[0]) {
        const hash = hashFile(pool[0].file);
        results.push({
          category,
          imageId: hash,
          blob: pool[0].file,
          hash,
          confidence: Math.min(0.95, 0.7 + pool[0].genderProbability * 0.2),
          qualityScore: pool[0].poseRank === 1 ? 1 : pool[0].poseRank === 2 ? 0.85 : 0.7,
          source: "local_ai",
          createdAt: now
        });
      }
    }
    for (const gender of ["male", "female"]) {
      const category = gender === "male" ? "male_face_closeup" : "female_face_closeup";
      const pool = candidates.filter((c) => c.gender === gender && c.age >= 13 && c.frontScore >= POSE_FRONT_FACING_MIN_SCORE).sort(
        (a, b) => b.frontScore - a.frontScore || b.faceAreaRatio - a.faceAreaRatio || b.genderProbability - a.genderProbability || b.detectionScore - a.detectionScore
      );
      if (pool[0]) {
        const hash = hashFile(pool[0].file);
        results.push({
          category,
          imageId: hash,
          blob: pool[0].file,
          hash,
          confidence: Math.min(0.95, 0.7 + pool[0].genderProbability * 0.2),
          qualityScore: pool[0].detectionScore,
          source: "local_ai",
          createdAt: now
        });
      }
    }
    const kidByCandidates = {
      kid_boy: candidates.filter((c) => c.age < 13 && c.gender === "male"),
      kid_girl: candidates.filter((c) => c.age < 13 && c.gender === "female")
    };
    for (const [kidGender, kidCandidates] of Object.entries(kidByCandidates)) {
      if (kidCandidates.length === 0) continue;
      const fullBodyCat = kidGender === "kid_boy" ? "kid_boy_full_body" : "kid_girl_full_body";
      const faceCat = kidGender === "kid_boy" ? "kid_boy_face_closeup" : "kid_girl_face_closeup";
      const bodyPool = kidCandidates.filter((c) => c.frontScore >= POSE_FRONT_FACING_MIN_SCORE && c.poseRank > 0).sort((a, b) => a.poseRank - b.poseRank || b.frontScore - a.frontScore);
      const bodyPick = bodyPool[0] ?? [...kidCandidates].sort((a, b) => b.genderProbability - a.genderProbability)[0];
      if (bodyPick) {
        const hash = hashFile(bodyPick.file);
        results.push({
          category: fullBodyCat,
          imageId: hash,
          blob: bodyPick.file,
          hash,
          confidence: 0.75,
          qualityScore: bodyPool[0] ? bodyPick.poseRank === 1 ? 1 : 0.8 : 0.6,
          source: "local_ai",
          createdAt: now
        });
      }
      const facePick = [...kidCandidates].filter((c) => c.frontScore >= POSE_FRONT_FACING_MIN_SCORE).sort(
        (a, b) => b.frontScore - a.frontScore || b.faceAreaRatio - a.faceAreaRatio || b.genderProbability - a.genderProbability || b.detectionScore - a.detectionScore
      )[0];
      if (facePick) {
        const hash = hashFile(facePick.file);
        results.push({
          category: faceCat,
          imageId: hash,
          blob: facePick.file,
          hash,
          confidence: 0.75,
          qualityScore: facePick.detectionScore,
          source: "local_ai",
          createdAt: now
        });
      }
    }
  }
  const TOP_ROOM_COUNT = 5;
  const roomBuckets = /* @__PURE__ */ new Map();
  for (const rc of roomCandidates) {
    if (!roomBuckets.has(rc.roomType)) roomBuckets.set(rc.roomType, []);
    roomBuckets.get(rc.roomType).push(rc);
  }
  for (const bucket of roomBuckets.values()) {
    bucket.sort((a, b) => b.yoloScore - a.yoloScore);
  }
  for (const [roomType, bucket] of roomBuckets) {
    const category = ROOM_TYPE_TO_CATEGORY[roomType];
    if (!category || bucket.length === 0) continue;
    const best = bucket[0];
    const hash = hashFile(best.file);
    results.push({
      category,
      imageId: hash,
      blob: best.file,
      hash,
      confidence: Math.min(0.95, best.confidence),
      qualityScore: best.confidence,
      source: "local_ai",
      createdAt: now
    });
  }
  const toTopRoomCandidate = (rc) => ({
    file: rc.file,
    hash: hashFile(rc.file),
    yoloScore: rc.yoloScore,
    confidence: rc.confidence,
    topLabel: rc.topLabel
  });
  const topRoomCandidates = {
    bedroom: (roomBuckets.get("bedroom") ?? []).slice(0, TOP_ROOM_COUNT).map(toTopRoomCandidate),
    living_room: (roomBuckets.get("living_room") ?? []).slice(0, TOP_ROOM_COUNT).map(toTopRoomCandidate),
    dining_room: (roomBuckets.get("dining_room") ?? []).slice(0, TOP_ROOM_COUNT).map(toTopRoomCandidate)
  };
  const toTopCandidate = (c) => ({
    file: c.file,
    hash: hashFile(c.file),
    age: c.age,
    poseRank: c.poseRank,
    frontScore: c.frontScore,
    genderProbability: c.genderProbability,
    detectionScore: c.detectionScore,
    faceAreaRatio: c.faceAreaRatio
  });
  const adultSort = (a, b) => a.poseRank - b.poseRank || b.frontScore - a.frontScore || b.genderProbability - a.genderProbability;
  const topCandidates = {
    male: candidates.filter((c) => c.gender === "male" && c.age >= 13).sort(adultSort).slice(0, 5).map(toTopCandidate),
    female: candidates.filter((c) => c.gender === "female" && c.age >= 13).sort(adultSort).slice(0, 5).map(toTopCandidate),
    kid_boy: candidates.filter((c) => c.gender === "male" && c.age < 13).sort(adultSort).slice(0, 5).map(toTopCandidate),
    kid_girl: candidates.filter((c) => c.gender === "female" && c.age < 13).sort(adultSort).slice(0, 5).map(toTopCandidate)
  };
  onProgress?.({ phase: "complete", message: "Selection complete." });
  return { assets: results, topCandidates, topRoomCandidates };
}

// src/tagging.ts
var CONFIDENCE_THRESHOLD = 0.7;
var MAX_SEND = 13;
var FallbackTaggingService = class {
  constructor(api, rateLimit, orgId, sessionId) {
    this.api = api;
    this.rateLimit = rateLimit;
    this.orgId = orgId;
    this.sessionId = sessionId;
  }
  /**
   * Decides whether fallback tagging is needed and runs it if so.
   * Returns the merged (improved) asset list.
   */
  async maybeTag(assets, requiredCategories, force = false) {
    if (!force && !this.shouldTag(assets, requiredCategories)) {
      return assets;
    }
    try {
      this.rateLimit.checkTagging();
    } catch {
      return assets;
    }
    const candidates = this.selectCandidates(assets);
    if (candidates.length === 0) return assets;
    let backendTags;
    try {
      backendTags = await this.callTaggingApi(candidates);
      this.rateLimit.recordTagging();
    } catch (e) {
      console.warn("[personalize-sdk] Fallback tagging failed:", normalizeError(e).message);
      return assets;
    }
    return this.mergeResults(assets, candidates, backendTags);
  }
  // ── Private helpers ────────────────────────────────────────────────────────
  shouldTag(assets, required) {
    if (assets.some((a) => a.confidence < CONFIDENCE_THRESHOLD)) return true;
    const available = new Set(assets.map((a) => a.category));
    if (required.some((c) => !available.has(c))) return true;
    return false;
  }
  selectCandidates(assets) {
    const seen = /* @__PURE__ */ new Set();
    const filtered = assets.filter((a) => {
      if (seen.has(a.hash)) return false;
      seen.add(a.hash);
      return true;
    }).sort((a, b) => a.confidence - b.confidence);
    return filtered.slice(0, MAX_SEND);
  }
  async callTaggingApi(candidates) {
    const formData = new FormData();
    formData.append("orgId", this.orgId);
    formData.append("sessionId", this.sessionId);
    const localCandidates = candidates.map((a) => ({
      imageId: a.imageId,
      candidateTags: [a.category],
      confidence: a.confidence
    }));
    formData.append("localCandidates", JSON.stringify(localCandidates));
    for (const asset of candidates) {
      formData.append("images", asset.blob, `${asset.imageId}.jpg`);
    }
    const response = await this.api.post("/v1/image-tagging", formData);
    return response?.tags ?? [];
  }
  mergeResults(original, sentCandidates, backendTags) {
    if (!backendTags.length) return original;
    const tagMap = new Map(backendTags.map((t) => [t.imageId, t]));
    const updatedMap = /* @__PURE__ */ new Map();
    for (const asset of original) {
      updatedMap.set(`${asset.category}:${asset.imageId}`, asset);
    }
    for (const candidate of sentCandidates) {
      const tag = tagMap.get(candidate.imageId);
      if (!tag) continue;
      const updated = {
        ...candidate,
        category: tag.category,
        confidence: tag.confidence,
        source: original.find((a) => a.imageId === candidate.imageId) ? "merged" : "backend_tagging"
      };
      updatedMap.set(`${tag.category}:${candidate.imageId}`, updated);
    }
    return Array.from(updatedMap.values());
  }
};

// src/mapping.ts
var PRODUCT_TYPE_MAPPING = {
  // Eyewear
  sunglasses: ["male_face_closeup", "female_face_closeup", "kid_boy_face_closeup", "kid_girl_face_closeup"],
  eyeglasses: ["male_face_closeup", "female_face_closeup", "kid_boy_face_closeup", "kid_girl_face_closeup"],
  // Clothing
  mens_clothing: ["male_full_body"],
  womens_clothing: ["female_full_body"],
  kids_clothing: ["kid_boy_full_body", "kid_girl_full_body"],
  // Footwear
  footwear: ["male_full_body", "female_full_body", "kid_boy_full_body", "kid_girl_full_body"],
  // Jewellery
  jewellery: ["female_face_closeup", "male_face_closeup"],
  earrings: ["female_face_closeup", "male_face_closeup"],
  // Bags
  bags: ["female_full_body", "male_full_body"],
  // Makeup
  makeup_lipstick: ["female_face_closeup", "male_face_closeup"],
  makeup_foundation: ["female_face_closeup", "male_face_closeup"],
  makeup_mascara: ["female_face_closeup", "male_face_closeup"],
  // Furniture & decor — requires a room photo of the matching space
  bedroom_furniture: ["room_bedroom"],
  bathroom_furniture: ["room_bathroom"],
  living_room_furniture: ["room_living_room"],
  dining_room_furniture: ["room_dining_room"],
  kitchen_furniture: ["room_kitchen"],
  // home_decor accepts any room type — first available match wins
  home_decor: ["room_bedroom", "room_living_room", "room_dining_room", "room_kitchen", "room_bathroom"]
};
var PRODUCT_NEEDS = {
  sunglasses: "face",
  eyeglasses: "face",
  mens_clothing: "body",
  womens_clothing: "body",
  kids_clothing: "body",
  footwear: "body",
  jewellery: "face",
  earrings: "face",
  bags: "body",
  makeup_lipstick: "face",
  makeup_foundation: "face",
  makeup_mascara: "face",
  bedroom_furniture: "room",
  bathroom_furniture: "room",
  living_room_furniture: "room",
  dining_room_furniture: "room",
  kitchen_furniture: "room",
  home_decor: "room"
};
function resolveCategoryFromGender(productType, gender) {
  const need = PRODUCT_NEEDS[productType];
  if (need === "room") return null;
  const isMale = gender === "male" || gender === "kid_boy";
  if (gender === "kid_boy") return need === "face" ? "kid_boy_face_closeup" : "kid_boy_full_body";
  if (gender === "kid_girl") return need === "face" ? "kid_girl_face_closeup" : "kid_girl_full_body";
  if (isMale) return need === "face" ? "male_face_closeup" : "male_full_body";
  return need === "face" ? "female_face_closeup" : "female_full_body";
}
function getRequiredCategories(productType) {
  return PRODUCT_TYPE_MAPPING[productType] ?? [];
}
function resolveEligibleCategory(productType, availableCategories) {
  const required = getRequiredCategories(productType);
  const available = new Set(availableCategories);
  return required.find((c) => available.has(c)) ?? null;
}
function checkEligibility(productType, summary) {
  if (!productType) {
    return {
      eligible: false,
      reason: "PRODUCT_TYPE_NOT_FOUND",
      availableCategories: summary?.availableCategories ?? []
    };
  }
  const available = summary?.availableCategories ?? [];
  const required = getRequiredCategories(productType);
  const match = resolveEligibleCategory(productType, available);
  if (!match) {
    return {
      eligible: false,
      reason: "REQUIRED_USER_IMAGE_MISSING",
      productType,
      requiredCategory: required[0],
      availableCategories: available
    };
  }
  return { eligible: true, productType, requiredCategory: match };
}

// src/sdk.ts
var PersonalizeSDK = class _PersonalizeSDK {
  constructor(config, orgId, sessionId) {
    // Mutable state
    this.selectedAssets = [];
    this.selectionSummary = null;
    this.currentProductContext = null;
    this.viewMode = "original";
    this.activeAbortController = null;
    /** GCS URLs keyed by asset hash — populated in background after ingestImages() */
    this.profileUrlCache = /* @__PURE__ */ new Map();
    // ── View helpers ────────────────────────────────────────────────────────────
    this.view = {
      showOriginal: () => {
        this.viewMode = "original";
        this.bus.emit("view:changed", { mode: "original" });
        this.analytics.viewChanged("original");
        this.dbg.setViewMode("original");
      },
      showPersonalized: () => {
        this.viewMode = "personalized";
        this.bus.emit("view:changed", { mode: "personalized" });
        this.analytics.viewChanged("personalized");
        this.dbg.setViewMode("personalized");
      },
      toggle: () => {
        const next = this.viewMode === "original" ? "personalized" : "original";
        if (next === "original") this.view.showOriginal();
        else this.view.showPersonalized();
      },
      getMode: () => this.viewMode
    };
    // ── Selection summary ───────────────────────────────────────────────────────
    this.selection = {
      getSummary: () => this.selectionSummary,
      getAssets: () => [...this.selectedAssets]
    };
    // ── Product ─────────────────────────────────────────────────────────────────
    this.product = {
      getContext: () => this.currentProductContext,
      refreshContext: (overrides) => this.resolveProduct(overrides)
    };
    // ── Cache ───────────────────────────────────────────────────────────────────
    this.cache = {
      clearProfile: () => this.cacheService.clearProfile(this.orgId),
      clearSelection: () => this.cacheService.clearSelection(),
      clearPersonalization: () => this.cacheService.clearPersonalization(),
      clearAll: () => this.cacheService.clearAll()
    };
    // ── Debug ───────────────────────────────────────────────────────────────────
    this.debug = {
      getState: () => this.dbg.getState()
    };
    this.config = config;
    this.orgId = orgId;
    this.sessionId = sessionId;
    this.bus = new EventBus();
    this.auth = new AuthService(config);
    this.api = new ApiClient(this.auth);
    this.cacheService = new CacheService();
    this.rateLimit = new RateLimitService(config.rateLimit);
    this.analytics = new AnalyticsService(config.analytics, orgId, sessionId);
    this.dbg = new DebugService(config.debug);
    this.productCtx = new ProductContextService(config.product, this.api);
    this.personalizationSvc = new PersonalizationService(
      this.api,
      this.cacheService,
      config,
      this.analytics,
      this.bus,
      orgId
    );
    this.taggingSvc = new FallbackTaggingService(this.api, this.rateLimit, orgId, sessionId);
  }
  // ── Static factory ──────────────────────────────────────────────────────────
  static async init(config) {
    const resolved = resolveConfig(config);
    const orgId = getOrgId(resolved) ?? "unknown";
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new _PersonalizeSDK(resolved, orgId, sessionId);
  }
  // ── Image ingestion + selection ─────────────────────────────────────────────
  async ingestImages(fileList, onProgress) {
    const fileCount = fileList?.length ?? 0;
    this.analytics.uploadStarted(fileCount);
    this.bus.emit("upload:started", { fileCount });
    this.dbg.log("ingest_images", { fileCount });
    let assets;
    let topCandidates;
    let topRoomCandidates;
    try {
      const output = await selectImages(
        fileList,
        (p) => {
          onProgress?.(p);
          this.bus.emit("selection:started", { fileCount });
        },
        this.config.personalizationMode
      );
      assets = output.assets;
      topCandidates = output.topCandidates;
      topRoomCandidates = output.topRoomCandidates;
    } catch (e) {
      const err = normalizeError(e);
      this.bus.emit("upload:failed", { error: err.message });
      this.bus.emit("error", err);
      throw err;
    }
    const allCategories = [
      // Person — fashion try-on
      "male_full_body",
      "female_full_body",
      "kid_boy_full_body",
      "kid_girl_full_body",
      "male_face_closeup",
      "female_face_closeup",
      "kid_boy_face_closeup",
      "kid_girl_face_closeup",
      // Room — furniture & home decor try-on
      "room_bedroom",
      "room_living_room",
      "room_dining_room",
      "room_kitchen",
      "room_bathroom"
    ];
    let taggedAssets = await this.taggingSvc.maybeTag(assets, allCategories);
    taggedAssets = await this.refineSelectionWithLLM(taggedAssets, topCandidates);
    taggedAssets = await this.refineRoomsWithLLM(taggedAssets, topRoomCandidates);
    this.selectedAssets = taggedAssets;
    void this.uploadProfilesInBackground(taggedAssets);
    const available = [...new Set(taggedAssets.map((a) => a.category))];
    const missing = allCategories.filter((c) => !available.includes(c));
    this.selectionSummary = {
      availableCategories: available,
      missingCategories: missing,
      totalUploaded: fileCount,
      totalSelected: taggedAssets.length
    };
    this.analytics.selectionCompleted(fileCount, assets.length, available);
    this.bus.emit("upload:completed", { fileCount, validCount: assets.length });
    this.bus.emit("selection:completed", this.selectionSummary);
    this.dbg.setSelectionSummary(this.selectionSummary, null);
    void this.cacheService.saveProfile(
      this.orgId,
      taggedAssets,
      Object.fromEntries(this.profileUrlCache),
      this.config.cache.selectionTtlMs
    ).catch(() => {
    });
    return this.selectionSummary;
  }
  // ── Profile restore ─────────────────────────────────────────────────────────
  /**
   * Restore a previously selected profile from cache.
   * Call this on page load — if a cached profile exists, the user can skip
   * the upload step entirely and go straight to personalization.
   *
   * Returns the SelectionSummary if a valid cached profile was found,
   * or null if no cache exists / cache has expired.
   */
  async restoreProfile() {
    try {
      const cached = await this.cacheService.loadProfile(this.orgId);
      if (!cached || cached.assets.length === 0) return null;
      this.selectedAssets = cached.assets;
      for (const [hash, url] of Object.entries(cached.profileUrls)) {
        this.profileUrlCache.set(hash, url);
      }
      const missingUploads = cached.assets.filter(
        (a) => !this.profileUrlCache.has(a.hash)
      );
      if (missingUploads.length > 0) {
        void this.uploadProfilesInBackground(missingUploads);
      }
      const allCategories = [
        "male_full_body",
        "female_full_body",
        "kid_boy_full_body",
        "kid_girl_full_body",
        "male_face_closeup",
        "female_face_closeup",
        "kid_boy_face_closeup",
        "kid_girl_face_closeup",
        "room_bedroom",
        "room_living_room",
        "room_dining_room",
        "room_kitchen",
        "room_bathroom"
      ];
      const available = [...new Set(cached.assets.map((a) => a.category))];
      const missing = allCategories.filter((c) => !available.includes(c));
      this.selectionSummary = {
        availableCategories: available,
        missingCategories: missing,
        totalUploaded: 0,
        // unknown on restore
        totalSelected: cached.assets.length
      };
      this.dbg.setSelectionSummary(this.selectionSummary, null);
      this.bus.emit("selection:completed", this.selectionSummary);
      this.dbg.log("profile_restored", { categories: available });
      return this.selectionSummary;
    } catch {
      return null;
    }
  }
  // ── Product context ─────────────────────────────────────────────────────────
  async resolveProduct(overrides) {
    let ctx;
    try {
      ctx = await this.productCtx.getContext(overrides);
    } catch (e) {
      const err = normalizeError(e);
      this.bus.emit("product:failed", { error: err.message });
      throw err;
    }
    this.currentProductContext = ctx;
    this.bus.emit("product:resolved", ctx);
    this.dbg.setProductContext(ctx);
    return ctx;
  }
  // ── Eligibility ─────────────────────────────────────────────────────────────
  async getEligibility(productType) {
    const type = productType ?? this.currentProductContext?.productType;
    const result = checkEligibility(type, this.selectionSummary);
    this.dbg.setEligibility(result);
    if (result.eligible) {
      this.bus.emit("eligibility:eligible", result);
    } else {
      this.bus.emit("eligibility:ineligible", result);
    }
    return result;
  }
  // ── Single-product personalization ─────────────────────────────────────────
  async personalize(opts) {
    const { imageUrl, productType, gender, productId } = opts;
    const ctx = await this.resolveProduct({ imageUrl, productType, productId });
    const resolvedCategory = resolveCategoryFromGender(ctx.productType, gender);
    let requiredCategory;
    if (resolvedCategory === null) {
      const eligibility = await this.getEligibility(ctx.productType);
      if (!eligibility.eligible) {
        throw normalizeError(new Error(`Product not eligible for personalization: ${eligibility.reason}`));
      }
      requiredCategory = eligibility.requiredCategory;
    } else {
      requiredCategory = resolvedCategory;
      const hasCategory = this.selectionSummary?.availableCategories.includes(requiredCategory);
      if (!hasCategory) {
        throw normalizeError(new Error(
          `No ${requiredCategory} photo found. Upload a ${gender} photo first.`
        ));
      }
    }
    const asset = this.selectedAssets.find((a) => a.category === requiredCategory);
    if (!asset) {
      throw normalizeError(new Error(`No asset found for category ${requiredCategory}`));
    }
    const productKey = `${ctx.image.imageUrl}:${ctx.productType}`;
    try {
      this.rateLimit.checkPersonalization(productKey);
    } catch (e) {
      this.analytics.rateLimitedClient();
      this.bus.emit("personalization:rate_limited", { reason: "client_rate_limit" });
      throw e;
    }
    const cfg = this.config.rateLimit.personalization;
    if (cfg?.singleFlight) {
      const inFlight = this.rateLimit.getInFlight(productKey);
      if (inFlight) return inFlight;
    }
    this.activeAbortController = new AbortController();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => this.activeAbortController?.abort());
    }
    const promise = this.personalizationSvc.personalize({
      userImage: asset.blob,
      userImageUrl: this.profileUrlCache.get(asset.hash),
      userImageHash: asset.hash,
      userImageCategory: asset.category,
      productImageUrl: ctx.image.imageUrl,
      productImageHash: ctx.image.imageUrl,
      productType: ctx.productType,
      productId: ctx.productId,
      abortSignal: this.activeAbortController.signal
    });
    this.rateLimit.registerInFlight(productKey, promise);
    this.rateLimit.recordPersonalization(productKey);
    this.dbg.setPersonalizationState("creating_job");
    try {
      const result = await promise;
      this.viewMode = "personalized";
      this.bus.emit("view:changed", { mode: "personalized" });
      this.dbg.setPersonalizationState("personalized", result.jobId);
      return result;
    } catch (e) {
      const err = normalizeError(e);
      this.dbg.setPersonalizationState("failed", null, err.message);
      this.analytics.personalizationFailed(err.message, err.code);
      this.bus.emit("personalization:failed", { error: err.message, code: err.code });
      this.bus.emit("error", err);
      throw err;
    } finally {
      this.activeAbortController = null;
    }
  }
  // ── Batch personalization ───────────────────────────────────────────────────
  async personalizeAll(products, onResult) {
    const results = await Promise.allSettled(
      products.map(async (p) => {
        const resolvedCategory = resolveCategoryFromGender(p.productType, p.gender);
        let requiredCategory;
        if (resolvedCategory === null) {
          const eligibility = checkEligibility(p.productType, this.selectionSummary);
          if (!eligibility.eligible) {
            const r = { productId: p.productId, status: "ineligible", reason: eligibility.reason };
            onResult?.(r);
            return r;
          }
          requiredCategory = eligibility.requiredCategory;
        } else {
          requiredCategory = resolvedCategory;
          const hasCategory = this.selectionSummary?.availableCategories.includes(requiredCategory);
          if (!hasCategory) {
            const r = { productId: p.productId, status: "ineligible", reason: "REQUIRED_USER_IMAGE_MISSING" };
            onResult?.(r);
            return r;
          }
        }
        const asset = this.selectedAssets.find((a) => a.category === requiredCategory);
        if (!asset) {
          const r = { productId: p.productId, status: "ineligible", reason: "REQUIRED_USER_IMAGE_MISSING" };
          onResult?.(r);
          return r;
        }
        try {
          const result = await this.personalizationSvc.personalize({
            userImage: asset.blob,
            userImageUrl: this.profileUrlCache.get(asset.hash),
            userImageHash: asset.hash,
            userImageCategory: asset.category,
            productImageUrl: p.imageUrl,
            productImageHash: p.imageUrl,
            productType: p.productType,
            productId: p.productId
          });
          const r = {
            productId: p.productId,
            status: "completed",
            imageUrl: result.imageUrl,
            cacheHit: result.cacheHit,
            jobId: result.jobId
          };
          onResult?.(r);
          return r;
        } catch (e) {
          const r = {
            productId: p.productId,
            status: "failed",
            error: normalizeError(e).message
          };
          onResult?.(r);
          return r;
        }
      })
    );
    return results.map(
      (r) => r.status === "fulfilled" ? r.value : { productId: "unknown", status: "failed", error: String(r.reason) }
    );
  }
  // ── Events ──────────────────────────────────────────────────────────────────
  on(event, handler) {
    return this.bus.on(event, handler);
  }
  off(event, handler) {
    this.bus.off(event, handler);
  }
  // ── Cancel + Reset ───────────────────────────────────────────────────────────
  // ── Private: GCS profile pre-upload ────────────────────────────────────────
  /**
   * Upload each unique selected asset to GCS in the background.
   * When a product submission fires later, profileUrlCache will already have
   * the URL — so we send user_image_url instead of re-uploading the blob.
   * Silent on failure: personalize() falls back to raw blob upload.
   */
  uploadProfilesInBackground(assets) {
    const seen = /* @__PURE__ */ new Set();
    for (const asset of assets) {
      if (seen.has(asset.hash) || this.profileUrlCache.has(asset.hash)) continue;
      seen.add(asset.hash);
      void (async () => {
        try {
          const url = await this.api.uploadUserImage(asset.blob, asset.hash);
          this.profileUrlCache.set(asset.hash, url);
          this.dbg.log("profile_upload_ok", { hash: asset.hash });
          void this.cacheService.updateProfileUrls(this.orgId, { [asset.hash]: url }).catch(() => {
          });
        } catch (e) {
          this.dbg.log("profile_upload_failed", { hash: asset.hash, error: normalizeError(e).message });
        }
      })();
    }
  }
  // ── Private: LLM profile refinement ────────────────────────────────────────
  /**
   * Optionally refine the local-AI selection using the Gennoctua LLM picker.
   * Compresses top-5 candidates per category to 512px, sends to /api/profile/select,
   * and swaps out any asset where the LLM found a better pick.
   * Falls back silently to the original assets on any error or timeout.
   */
  async refineSelectionWithLLM(assets, topCandidates) {
    const hasAnyCandidates = Object.values(topCandidates).some((arr) => arr.length > 0);
    if (!hasAnyCandidates) return assets;
    try {
      const compress = (file) => new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          const maxSide = 512;
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("compress failed"));
        };
        img.src = objectUrl;
      });
      const idToCandidate = /* @__PURE__ */ new Map();
      const buildPayload = async (cat, gender) => {
        const result = [];
        for (let i = 0; i < topCandidates[cat].length; i++) {
          const c = topCandidates[cat][i];
          const id = `${cat}_${i}`;
          idToCandidate.set(id, c);
          const imageDataUrl = await compress(c.file).catch(() => "");
          if (!imageDataUrl) continue;
          result.push({
            id,
            imageDataUrl,
            poseScore: c.poseRank,
            faceCount: 1,
            photoName: c.file.name,
            detectedGender: gender,
            detectedAge: Math.round(c.age)
          });
        }
        return result;
      };
      const [male, female, kid_boy, kid_girl] = await Promise.all([
        buildPayload("male", "male"),
        buildPayload("female", "female"),
        buildPayload("kid_boy", "male"),
        buildPayload("kid_girl", "female")
      ]);
      const llmResult = await this.api.selectProfilesWithLLM({ categories: { male, female, kid_boy, kid_girl } });
      if (llmResult.skipped) return assets;
      const updatedAssets = [...assets];
      for (const [catKey, selectedId] of Object.entries(llmResult.selected)) {
        if (!selectedId) continue;
        const candidate = idToCandidate.get(selectedId);
        if (!candidate) continue;
        const newHash = candidate.hash;
        const targetCategories = catKey === "kid_boy" ? ["kid_boy_full_body", "kid_boy_face_closeup"] : catKey === "kid_girl" ? ["kid_girl_full_body", "kid_girl_face_closeup"] : catKey === "male" ? ["male_full_body", "male_face_closeup"] : ["female_full_body", "female_face_closeup"];
        for (const targetCat of targetCategories) {
          const idx = updatedAssets.findIndex((a) => a.category === targetCat);
          if (idx === -1) continue;
          if ((targetCat === "male_full_body" || targetCat === "female_full_body" || targetCat === "kid_boy_full_body" || targetCat === "kid_girl_full_body") && candidate.poseRank === 0) {
            continue;
          }
          updatedAssets[idx] = {
            ...updatedAssets[idx],
            imageId: newHash,
            blob: candidate.file,
            hash: newHash,
            source: "merged"
          };
        }
      }
      this.dbg.log("llm_profile_refinement_ok", { model: llmResult.model });
      return updatedAssets;
    } catch (e) {
      const err = normalizeError(e);
      this.dbg.log("llm_profile_refinement_failed", { error: err.message, details: err.details });
      return assets;
    }
  }
  // ── Private: LLM room refinement ───────────────────────────────────────────
  /**
   * Optionally refine the YOLO room selection using the Gennoctua LLM room picker.
   * Compresses top-5 candidates per room type to 512px, sends to /api/room/select,
   * and swaps out any asset where the LLM found a better pick.
   * Falls back silently to the original YOLO picks on any error or timeout.
   */
  async refineRoomsWithLLM(assets, topRoomCandidates) {
    const hasAnyCandidates = topRoomCandidates.bedroom.length > 0 || topRoomCandidates.living_room.length > 0 || topRoomCandidates.dining_room.length > 0;
    if (!hasAnyCandidates) return assets;
    try {
      const compress = (file) => new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          const scale = Math.min(1, 512 / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("compress failed"));
        };
        img.src = objectUrl;
      });
      const idToFile = /* @__PURE__ */ new Map();
      const buildPayload = async (roomKey) => {
        const result = [];
        for (let i = 0; i < topRoomCandidates[roomKey].length; i++) {
          const c = topRoomCandidates[roomKey][i];
          const id = `${roomKey}_${i}`;
          idToFile.set(id, c.file);
          const imageDataUrl = await compress(c.file).catch(() => "");
          if (!imageDataUrl) continue;
          result.push({ id, imageDataUrl, yoloScore: c.yoloScore, topLabel: c.topLabel });
        }
        return result;
      };
      const [bedroom, living_room, dining_room] = await Promise.all([
        buildPayload("bedroom"),
        buildPayload("living_room"),
        buildPayload("dining_room")
      ]);
      const llmResult = await this.api.selectRoomsWithLLM({ categories: { bedroom, living_room, dining_room } });
      if (llmResult.skipped) return assets;
      const updatedAssets = [...assets];
      const roomKeyToCategory = {
        bedroom: "room_bedroom",
        living_room: "room_living_room",
        dining_room: "room_dining_room"
      };
      for (const [roomKey, selectedId] of Object.entries(llmResult.selected)) {
        const targetCat = roomKeyToCategory[roomKey];
        if (!selectedId) {
          if (topRoomCandidates[roomKey].length > 0) {
            const idx2 = updatedAssets.findIndex((a) => a.category === targetCat);
            if (idx2 !== -1) updatedAssets.splice(idx2, 1);
          }
          continue;
        }
        const file = idToFile.get(selectedId);
        if (!file) continue;
        const idx = updatedAssets.findIndex((a) => a.category === targetCat);
        if (idx === -1) continue;
        const newHash = `${file.name}-${file.size}-${file.lastModified}`;
        updatedAssets[idx] = {
          ...updatedAssets[idx],
          imageId: newHash,
          blob: file,
          hash: newHash,
          source: "merged"
        };
      }
      this.dbg.log("llm_room_refinement_ok", { model: llmResult.model });
      return updatedAssets;
    } catch (e) {
      this.dbg.log("llm_room_refinement_failed", { error: normalizeError(e).message });
      return assets;
    }
  }
  cancel() {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.bus.emit("personalization:cancelled", {});
  }
  reset() {
    this.cancel();
    this.selectedAssets = [];
    this.selectionSummary = null;
    this.profileUrlCache.clear();
    this.currentProductContext = null;
    this.viewMode = "original";
    this.rateLimit.reset();
    this.dbg.setProductContext(null);
    this.dbg.setSelectionSummary(null, null);
    this.dbg.setEligibility(null);
    this.dbg.setPersonalizationState("idle");
    void this.cacheService.clearProfile(this.orgId).catch(() => {
    });
  }
};
var Personalize = {
  init: PersonalizeSDK.init
};

export { DEFAULT_ROOM_MODEL_URL, Personalize, PersonalizeSDK, classifyRoom, resetRoomClassifier };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map