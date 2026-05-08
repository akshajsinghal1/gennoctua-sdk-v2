// src/errors.ts
var SDKError = class extends Error {
  constructor(opts) {
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
      details: this.details
    };
  }
};
function networkError(message, details) {
  return new SDKError({ code: "NETWORK_ERROR", message, recoverable: true, details });
}
function configError(message, details) {
  return new SDKError({ code: "CONFIG_INVALID", message, recoverable: false, details });
}
function rateLimitedError() {
  return new SDKError({
    code: "RATE_LIMITED_CLIENT",
    message: "Request blocked by client-side rate limit. Please wait before trying again.",
    recoverable: true
  });
}
function jobTimeoutError(attempts) {
  return new SDKError({
    code: "PERSONALIZATION_JOB_TIMEOUT",
    message: `Personalization timed out after ${attempts} polling attempts.`,
    recoverable: true,
    details: { attempts }
  });
}
function jobFailedError(details) {
  return new SDKError({
    code: "PERSONALIZATION_JOB_FAILED",
    message: "Personalization job failed on the server.",
    recoverable: true,
    details
  });
}
function cacheError(message) {
  return new SDKError({ code: "CACHE_ERROR", message, recoverable: true });
}
function normalizeError(e) {
  if (e instanceof SDKError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (message.toLowerCase().includes("network") || message.toLowerCase().includes("fetch")) {
    return networkError(message);
  }
  return new SDKError({ code: "NETWORK_ERROR", message, recoverable: true });
}

// src/api-client.ts
var ENDPOINTS = {
  // Person try-on (fashion, eyewear, footwear, makeup, accessories)
  submit: "/submit",
  status: "/status",
  // Room generation (furniture, home decor)
  generateRoom: "/api/gen/generate-room",
  roomStatus: "/api/gen/status",
  // Shared utilities
  uploadImage: "/api/uploads/user-image",
  profileSelect: "/api/profile/select",
  roomSelect: "/api/room/select"
};
var EC_BASE_URL = "https://ec.gennoctua.com";
var ApiClient = class {
  constructor(auth) {
    this.auth = auth;
  }
  // ── POST (multipart or JSON) ────────────────────────────────────────────────
  async post(path, body) {
    const headers = await this.auth.getHeaders();
    const baseUrl = this.auth.getProxyUrl();
    const isFormData = body instanceof FormData;
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: isFormData ? headers : { ...headers, "content-type": "application/json" },
        body: isFormData ? body : JSON.stringify(body)
      });
    } catch (e) {
      throw networkError(`POST ${path} failed: ${normalizeError(e).message}`);
    }
    return this.parseResponse(res, path);
  }
  // ── GET ─────────────────────────────────────────────────────────────────────
  async get(path) {
    const headers = await this.auth.getHeaders();
    const baseUrl = this.auth.getProxyUrl();
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { ...headers, accept: "application/json" }
      });
    } catch (e) {
      throw networkError(`GET ${path} failed: ${normalizeError(e).message}`);
    }
    return this.parseResponse(res, path);
  }
  // ── SSE stream ──────────────────────────────────────────────────────────────
  /**
   * Opens a Server-Sent Events stream and calls onEvent for each parsed data line.
   * Resolves when the stream closes (job reaches terminal state).
   * Rejects on network error or abort.
   */
  async stream(path, onEvent, signal) {
    const headers = await this.auth.getHeaders();
    const baseUrl = this.auth.getProxyUrl();
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, { headers, signal });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw networkError(`SSE ${path} failed: ${normalizeError(e).message}`);
    }
    if (!res.ok) {
      throw new SDKError({
        code: "NETWORK_ERROR",
        message: `SSE ${path} returned HTTP ${res.status}`,
        recoverable: true
      });
    }
    if (!res.body) {
      throw networkError(`SSE ${path}: no response body`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            const parsed = JSON.parse(raw);
            onEvent(parsed);
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  // ── Profile image upload ─────────────────────────────────────────────────────
  /**
   * Upload a user profile image to GCS via Gennoctua's upload endpoint.
   * Returns the permanent public GCS URL.
   * profileKey is used for GCS path organisation (e.g. the asset hash).
   */
  async uploadUserImage(blob, _profileKey) {
    const headers = await this.auth.getHeaders();
    const form = new FormData();
    form.append("file", blob, "profile.jpg");
    const url = `${EC_BASE_URL}${ENDPOINTS.uploadImage}`;
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: form });
    } catch (e) {
      throw networkError(`Profile upload failed: ${normalizeError(e).message}`);
    }
    const data = await this.parseResponse(res, ENDPOINTS.uploadImage);
    const gcsUrl = typeof data.gcs_url === "string" ? data.gcs_url : null;
    if (!gcsUrl) throw networkError("Upload endpoint did not return gcs_url");
    return gcsUrl;
  }
  // ── LLM room refinement ─────────────────────────────────────────────────────
  /**
   * Send top-5 room candidates per room type to the Gennoctua LLM room selector.
   * Returns which candidate ID was chosen per room type.
   * Silently falls back if endpoint is unavailable.
   */
  async selectRoomsWithLLM(payload) {
    const headers = await this.auth.getHeaders();
    const url = `${EC_BASE_URL}${ENDPOINTS.roomSelect}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      throw networkError(`LLM room select failed: ${normalizeError(e).message}`);
    }
    return await this.parseResponse(res, ENDPOINTS.roomSelect);
  }
  // ── LLM profile refinement ───────────────────────────────────────────────────
  /**
   * Send top-5 candidates per category to the Gennoctua LLM profile selector.
   * Returns which candidate ID was chosen per category, plus full scoring.
   * Silently falls back if endpoint is unavailable.
   */
  async selectProfilesWithLLM(payload) {
    const headers = await this.auth.getHeaders();
    const url = `${EC_BASE_URL}${ENDPOINTS.profileSelect}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      throw networkError(`LLM profile select failed: ${normalizeError(e).message}`);
    }
    return await this.parseResponse(res, ENDPOINTS.profileSelect);
  }
  // ── Response parser ─────────────────────────────────────────────────────────
  async parseResponse(res, path) {
    if (res.status === 401 || res.status === 403) {
      throw new SDKError({
        code: "AUTH_INVALID",
        message: `Auth rejected by server (HTTP ${res.status}) at ${path}`,
        recoverable: false
      });
    }
    if (res.status === 429) {
      throw new SDKError({
        code: "RATE_LIMITED_SERVER",
        message: "Server rate limit exceeded. Please slow down.",
        recoverable: true
      });
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
      }
      throw networkError(`HTTP ${res.status} at ${path}`, { body: detail });
    }
    try {
      return await res.json();
    } catch {
      throw networkError(`Invalid JSON response from ${path}`);
    }
  }
};

export { ApiClient, ENDPOINTS, SDKError, cacheError, configError, jobFailedError, jobTimeoutError, normalizeError, rateLimitedError };
//# sourceMappingURL=chunk-LT23N6M7.js.map
//# sourceMappingURL=chunk-LT23N6M7.js.map