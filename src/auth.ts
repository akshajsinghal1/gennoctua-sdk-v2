import type { ResolvedConfig } from "./config.js";

const DEFAULT_GENNOCTUA_URL = "https://token.gennoctua.com";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * AuthService — handles both auth modes:
 * - ProxyAuth: brand provides getToken() + proxyUrl
 * - PublicKeyAuth: SDK auto-exchanges publicKey for a short-lived JWT from Gennoctua
 */
export class AuthService {
  private config: ResolvedConfig;

  // PublicKey mode — cached token state
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: ResolvedConfig) {
    this.config = config;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.resolveToken();
    return {
      "Authorization": `Bearer ${token}`,
      "X-SDK-Version": SDK_VERSION,
    };
  }

  getProxyUrl(): string {
    const auth = this.config.auth;
    if ("proxyUrl" in auth) {
      return auth.proxyUrl;
    }
    // publicKey mode — use Gennoctua as proxy
    return (auth.gennoctuaUrl ?? DEFAULT_GENNOCTUA_URL) + "/api/tryon";
  }

  // ── Token resolution ────────────────────────────────────────────────────────

  private async resolveToken(): Promise<string> {
    const auth = this.config.auth;

    // Full-stack mode — brand provides token
    if ("getToken" in auth) {
      return await auth.getToken();
    }

    // Frontend-only mode — auto-exchange publicKey for JWT
    return this.getPublicKeyToken(auth.publicKey, auth.gennoctuaUrl ?? DEFAULT_GENNOCTUA_URL);
  }

  private async getPublicKeyToken(publicKey: string, gennoctuaUrl: string): Promise<string> {
    // Return cached token if still valid
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.cachedToken;
    }

    // Exchange publicKey for JWT
    const res = await fetch(`${gennoctuaUrl}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey }),
    });

    if (!res.ok) {
      throw new Error(`Failed to get token from Gennoctua: HTTP ${res.status}`);
    }

    const data = await res.json() as { token: string; expiresIn: number };
    this.cachedToken = data.token;
    this.tokenExpiresAt = Date.now() + data.expiresIn * 1000;

    return this.cachedToken;
  }
}

// Injected at build time by tsup define. Falls back to "dev" in tests.
declare const SDK_VERSION: string;
