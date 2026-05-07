import { ApiClient, normalizeError, cacheError, rateLimitedError, SDKError, jobFailedError, jobTimeoutError, configError } from './chunk-64OGGIDA.js';
export { SDKError } from './chunk-64OGGIDA.js';

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
   * Calls POST https://ec.gennoctua.com/api/detect-product-type
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
  bedroom_furniture: "accessories",
  bathroom_furniture: "accessories",
  living_room_furniture: "accessories",
  kitchen_furniture: "accessories",
  home_decor: "accessories"
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
    if (!jobId) {
      const form = new FormData();
      form.append("user_image", userImage, "profile.jpg");
      form.append("garment_image_url", productImageUrl);
      form.append("product_type", PRODUCT_TYPE_LABEL[productType] ?? productType);
      form.append("category", BROAD_CATEGORY[productType] ?? "accessories");
      if (abortSignal?.aborted) {
        this.bus.emit("personalization:cancelled", {});
        throw new Error("Cancelled");
      }
      const { ENDPOINTS: ENDPOINTS2 } = await import('./api-client-O72SWFIZ.js');
      const body = await this.api.post(ENDPOINTS2.submit, form);
      jobId = typeof body.job_id === "string" ? body.job_id : null;
      if (!jobId) throw jobFailedError({ response: body });
      await this.cache.setActiveJob(activeJobKey, jobId);
      this.analytics.personalizationJobCreated(jobId);
      this.bus.emit("personalization:job_created", { jobId });
    }
    this.bus.emit("personalization:polling_started", { jobId });
    const { ENDPOINTS } = await import('./api-client-O72SWFIZ.js');
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

// src/selection.ts
var FACE_API_CDN = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
var FACE_MODELS_CDN = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/";
var MEDIAPIPE_TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs";
var MEDIAPIPE_TASKS_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
var POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
var MAX_IMAGES = 80;
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
function ensurePoseReady() {
  if (!posePromise) {
    posePromise = (async () => {
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
async function hashFile(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}
function filterValidImages(fileList) {
  return Array.from(fileList || []).filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name)).slice(0, MAX_IMAGES);
}
function point(kp, index, min = 0.2) {
  const p = kp[index];
  if (!p || typeof p.visibility === "number" && p.visibility < min) return null;
  return p;
}
async function getPoseScore(file, detector) {
  const img = await fileToImage(file);
  const canvas = document.createElement("canvas");
  const maxSide = 1024;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    const result = detector.detect(canvas);
    if (!result?.landmarks?.length || result.landmarks.length > 1) return 0;
    const kp = result.landmarks[0];
    if (!point(kp, 11) || !point(kp, 12) || !point(kp, 23) || !point(kp, 24)) return 0;
    if (point(kp, 27) && point(kp, 28)) return 1;
    if (point(kp, 25) && point(kp, 26)) return 2;
    return 3;
  } catch {
    return 0;
  }
}
async function selectImages(fileList, onProgress) {
  const files = filterValidImages(fileList);
  if (files.length === 0) {
    throw new SDKError({
      code: "UPLOAD_FAILED",
      message: "No valid image files found.",
      recoverable: true
    });
  }
  onProgress?.({ phase: "loading_models", message: "Loading AI models..." });
  const [faceapi, pose] = await Promise.all([ensureFaceApiReady(), ensurePoseReady()]);
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.5 });
  const candidates = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.({
      phase: "categorizing",
      message: `Scanning faces ${i + 1} of ${files.length}...`,
      current: i + 1,
      total: files.length
    });
    try {
      const img = await fileToImage(files[i]);
      const faces = await faceapi.detectAllFaces(img, opts).withFaceLandmarks(true).withAgeAndGender();
      if (faces.length !== 1) continue;
      const face = faces[0];
      const gender = face.gender === "male" || face.gender === "female" ? face.gender : null;
      if (!gender || (face.genderProbability ?? 0) < 0.7) continue;
      const age = typeof face.age === "number" ? face.age : 25;
      candidates.push({ file: files[i], gender, age, poseScore: 0 });
    } catch {
    }
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    onProgress?.({
      phase: "ranking",
      message: `Ranking photos ${i + 1} of ${candidates.length}...`,
      current: i + 1,
      total: candidates.length
    });
    try {
      c.poseScore = await getPoseScore(c.file, pose);
    } catch {
      c.poseScore = 0;
    }
  }
  const results = [];
  for (const gender of ["male", "female"]) {
    const category = gender === "male" ? "male_full_body" : "female_full_body";
    const pool = candidates.filter((c) => c.gender === gender && c.poseScore > 0).sort((a, b) => a.poseScore - b.poseScore);
    if (pool[0]) {
      const hash = await hashFile(pool[0].file);
      results.push({
        category,
        imageId: hash,
        blob: pool[0].file,
        hash,
        confidence: 0.85,
        qualityScore: 1 / pool[0].poseScore,
        // lower score = better
        source: "local_ai",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  }
  for (const gender of ["male", "female"]) {
    const category = gender === "male" ? "male_face_closeup" : "female_face_closeup";
    const pool = candidates.filter((c) => c.gender === gender);
    if (pool[0]) {
      const hash = await hashFile(pool[0].file);
      results.push({
        category,
        imageId: hash,
        blob: pool[0].file,
        hash,
        confidence: 0.8,
        qualityScore: 0.8,
        source: "local_ai",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  }
  for (const gender of ["male", "female"]) {
    const bodyCategory = "child_full_body";
    const faceCategory = gender === "male" ? "child_face_closeup" : "child_face_closeup";
    const pool = candidates.filter((c) => c.gender === gender && c.age < 13);
    if (pool[0]) {
      const hash = await hashFile(pool[0].file);
      const base = {
        imageId: hash,
        blob: pool[0].file,
        hash,
        confidence: 0.75,
        qualityScore: 0.75,
        source: "local_ai",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (!results.find((r) => r.category === bodyCategory)) {
        results.push({ ...base, category: bodyCategory });
      }
      if (!results.find((r) => r.category === faceCategory)) {
        results.push({ ...base, category: faceCategory });
      }
    }
  }
  onProgress?.({ phase: "complete", message: "Selection complete." });
  return results;
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
  sunglasses: ["male_face_closeup", "female_face_closeup", "child_face_closeup"],
  eyeglasses: ["male_face_closeup", "female_face_closeup", "child_face_closeup"],
  // Clothing
  mens_clothing: ["male_full_body"],
  womens_clothing: ["female_full_body"],
  kids_clothing: ["child_full_body"],
  // Footwear
  footwear: ["male_full_body", "female_full_body", "child_full_body"],
  // Jewellery
  jewellery: ["female_face_closeup", "male_face_closeup"],
  earrings: ["female_face_closeup", "male_face_closeup"],
  // Bags
  bags: ["female_full_body", "male_full_body"],
  // Makeup
  makeup_lipstick: ["female_face_closeup", "male_face_closeup"],
  makeup_foundation: ["female_face_closeup", "male_face_closeup"],
  makeup_mascara: ["female_face_closeup", "male_face_closeup"],
  // Furniture & decor — Phase 2, no user image category yet
  bedroom_furniture: [],
  bathroom_furniture: [],
  living_room_furniture: [],
  kitchen_furniture: [],
  home_decor: []
};
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
  if (required.length === 0) {
    return {
      eligible: false,
      reason: "PRODUCT_TYPE_UNSUPPORTED",
      productType,
      availableCategories: available
    };
  }
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
    try {
      assets = await selectImages(fileList, (p) => {
        onProgress?.(p);
        this.bus.emit("selection:started", { fileCount });
      });
    } catch (e) {
      const err = normalizeError(e);
      this.bus.emit("upload:failed", { error: err.message });
      this.bus.emit("error", err);
      throw err;
    }
    const allCategories = [
      "male_full_body",
      "female_full_body",
      "child_full_body",
      "male_face_closeup",
      "female_face_closeup",
      "child_face_closeup"
    ];
    const taggedAssets = await this.taggingSvc.maybeTag(assets, allCategories);
    this.selectedAssets = taggedAssets;
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
    return this.selectionSummary;
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
  async personalize(overrides) {
    const ctx = overrides ? await this.resolveProduct(overrides) : this.currentProductContext ?? await this.resolveProduct();
    const eligibility = await this.getEligibility(ctx.productType);
    if (!eligibility.eligible) {
      throw normalizeError(
        new Error(
          `Product not eligible for personalization: ${eligibility.reason}`
        )
      );
    }
    const requiredCategory = eligibility.requiredCategory;
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
    const promise = this.personalizationSvc.personalize({
      userImage: asset.blob,
      userImageHash: asset.hash,
      userImageCategory: asset.category,
      productImageUrl: ctx.image.imageUrl,
      productImageHash: ctx.image.imageUrl,
      // URL used as hash for product images
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
        const eligibility = checkEligibility(p.productType, this.selectionSummary);
        if (!eligibility.eligible) {
          return {
            productId: p.productId,
            status: "ineligible",
            reason: eligibility.reason
          };
        }
        const asset = this.selectedAssets.find(
          (a) => a.category === eligibility.requiredCategory
        );
        if (!asset) {
          return { productId: p.productId, status: "ineligible", reason: "REQUIRED_USER_IMAGE_MISSING" };
        }
        try {
          const result = await this.personalizationSvc.personalize({
            userImage: asset.blob,
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
  cancel() {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.bus.emit("personalization:cancelled", {});
  }
  reset() {
    this.cancel();
    this.selectedAssets = [];
    this.selectionSummary = null;
    this.currentProductContext = null;
    this.viewMode = "original";
    this.rateLimit.reset();
    this.dbg.setProductContext(null);
    this.dbg.setSelectionSummary(null, null);
    this.dbg.setEligibility(null);
    this.dbg.setPersonalizationState("idle");
  }
};
var Personalize = {
  init: PersonalizeSDK.init
};

export { Personalize, PersonalizeSDK };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map