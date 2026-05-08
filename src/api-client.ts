import type { AuthService } from "./auth.js";
import { networkError, normalizeError, SDKError } from "./errors.js";

// ─── LLM Profile Types ────────────────────────────────────────────────────────

export type LLMCandidate = {
  id: string;
  imageDataUrl: string;   // base64 JPEG, max 512px
  poseScore: number;
  faceCount: number;
  photoName: string;
  detectedGender: "male" | "female" | "unknown";
  detectedAge: number | null;
};

export type LLMScoredRow = {
  id: string;
  finalScore: number | null;
  singlePersonScore: number | null;
  visiblePeopleEstimate: number | null;
  faceClarityScore: number | null;
  bodySeparationScore: number | null;
  predictedGender: string;
  predictedAgeBand: string;
  kidLikelihood: number | null;
};

export type LLMProfileResult = {
  selected: { male: string | null; female: string | null; kid_boy: string | null; kid_girl: string | null };
  source:   { male: string;        female: string;        kid_boy: string;        kid_girl: string };
  scored:   { male: LLMScoredRow[]; female: LLMScoredRow[]; kid_boy: LLMScoredRow[]; kid_girl: LLMScoredRow[] };
  skipped?: boolean;
  reason?:  string;
  model?:   string;
};

// ─── LLM Room Types ───────────────────────────────────────────────────────────

export type LLMRoomCandidate = {
  id: string;
  imageDataUrl: string;   // base64 JPEG, max 512px
  yoloScore: number;
  topLabel: string;
};

export type LLMRoomSelectResult = {
  selected: {
    bedroom:     string | null;
    living_room: string | null;
    dining_room: string | null;
  };
  skipped?: boolean;
  reason?:  string;
  model?:   string;
};

export const ENDPOINTS = {
  // Person try-on (fashion, eyewear, footwear, makeup, accessories)
  submit:         "/submit",
  status:         "/status",
  // Room generation (furniture, home decor)
  generateRoom:   "/api/gen/generate-room",
  roomStatus:     "/api/gen/status",
  // Shared utilities
  uploadImage:    "/api/uploads/user-image",
  profileSelect:  "/api/profile/select",
  roomSelect:     "/api/room/select",
} as const;


export class ApiClient {
  private auth: AuthService;

  constructor(auth: AuthService) {
    this.auth = auth;
  }

  // ── POST (multipart or JSON) ────────────────────────────────────────────────

  async post(path: string, body: FormData | Record<string, unknown>): Promise<unknown> {
    const headers = await this.auth.getHeaders();
    const baseUrl = this.auth.getProxyUrl();
    const isFormData = body instanceof FormData;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: isFormData ? headers : { ...headers, "content-type": "application/json" },
        body: isFormData ? body : JSON.stringify(body),
      });
    } catch (e) {
      throw networkError(`POST ${path} failed: ${normalizeError(e).message}`);
    }

    return this.parseResponse(res, path);
  }

  // ── GET ─────────────────────────────────────────────────────────────────────

  async get(path: string): Promise<unknown> {
    const headers = await this.auth.getHeaders();
    const baseUrl = this.auth.getProxyUrl();

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { ...headers, accept: "application/json" },
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
  async stream(
    path: string,
    onEvent: (data: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers = await this.auth.getHeaders();
    const baseUrl = this.auth.getProxyUrl();

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { headers, signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw networkError(`SSE ${path} failed: ${normalizeError(e).message}`);
    }

    if (!res.ok) {
      throw new SDKError({
        code: "NETWORK_ERROR",
        message: `SSE ${path} returned HTTP ${res.status}`,
        recoverable: true,
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
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            onEvent(parsed);
          } catch {
            // ignore malformed SSE lines
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
  async uploadUserImage(blob: Blob, _profileKey: string): Promise<string> {
    const headers = await this.auth.getHeaders();
    const form = new FormData();
    form.append("file", blob, "profile.jpg");
    const url = `${this.auth.getProxyUrl()}${ENDPOINTS.uploadImage}`;

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: form });
    } catch (e) {
      throw networkError(`Profile upload failed: ${normalizeError(e).message}`);
    }

    const data = await this.parseResponse(res, ENDPOINTS.uploadImage) as Record<string, unknown>;
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
  async selectRoomsWithLLM(payload: {
    categories: {
      bedroom:     LLMRoomCandidate[];
      living_room: LLMRoomCandidate[];
      dining_room: LLMRoomCandidate[];
    };
  }): Promise<LLMRoomSelectResult> {
    const headers = await this.auth.getHeaders();
    const url = `${this.auth.getProxyUrl()}${ENDPOINTS.roomSelect}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw networkError(`LLM room select failed: ${normalizeError(e).message}`);
    }

    return await this.parseResponse(res, ENDPOINTS.roomSelect) as LLMRoomSelectResult;
  }

  // ── LLM profile refinement ───────────────────────────────────────────────────

  /**
   * Send top-5 candidates per category to the Gennoctua LLM profile selector.
   * Returns which candidate ID was chosen per category, plus full scoring.
   * Silently falls back if endpoint is unavailable.
   */
  async selectProfilesWithLLM(payload: {
    categories: {
      male:    LLMCandidate[];
      female:  LLMCandidate[];
      kid_boy: LLMCandidate[];
      kid_girl: LLMCandidate[];
    };
  }): Promise<LLMProfileResult> {
    const headers = await this.auth.getHeaders();
    const url = `${this.auth.getProxyUrl()}${ENDPOINTS.profileSelect}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw networkError(`LLM profile select failed: ${normalizeError(e).message}`);
    }

    return await this.parseResponse(res, ENDPOINTS.profileSelect) as LLMProfileResult;
  }

  // ── Response parser ─────────────────────────────────────────────────────────

  private async parseResponse(res: Response, path: string): Promise<unknown> {
    if (res.status === 401 || res.status === 403) {
      throw new SDKError({
        code: "AUTH_INVALID",
        message: `Auth rejected by server (HTTP ${res.status}) at ${path}`,
        recoverable: false,
      });
    }

    if (res.status === 429) {
      throw new SDKError({
        code: "RATE_LIMITED_SERVER",
        message: "Server rate limit exceeded. Please slow down.",
        recoverable: true,
      });
    }

    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch { /* ignore */ }
      throw networkError(`HTTP ${res.status} at ${path}`, { body: detail });
    }

    try {
      return await res.json();
    } catch {
      throw networkError(`Invalid JSON response from ${path}`);
    }
  }
}
