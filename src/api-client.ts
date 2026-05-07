import type { AuthService } from "./auth.js";
import { networkError, normalizeError, SDKError } from "./errors.js";

export const ENDPOINTS = {
  submit: "/submit",
  status: "/status",
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
