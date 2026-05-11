import type { ApiClient } from "./api-client.js";
import type { ResolvedConfig } from "./config.js";
import type { ProductContext, ProductImageContext, ProductType } from "./types.js";
import { SDKError } from "./errors.js";

/**
 * ProductContextService
 *
 * Resolves product image and product type from (in priority order):
 * 1. Manual override passed by the brand
 * 2. Config-level productType / rules
 * 3. JSON-LD structured data on the page
 * 4. DOM heuristics
 * 5. Gennoctua /api/detect-product-type (LLM fallback — Gemini on server)
 */
export class ProductContextService {
  private config: ResolvedConfig["product"];
  private api: ApiClient;

  constructor(config: ResolvedConfig["product"], api: ApiClient) {
    this.config = config;
    this.api = api;
  }

  async getContext(overrides?: {
    imageUrl?: string;
    productType?: ProductType;
    productId?: string;
    productTitle?: string;
  }): Promise<ProductContext> {
    const image = await this.resolveProductImage(overrides?.imageUrl);

    if (!image) {
      throw new SDKError({
        code: "PRODUCT_CONTEXT_NOT_FOUND",
        message: "Could not resolve a product image. Configure product.imageSelector or pass imageUrl directly.",
        recoverable: false,
      });
    }

    // Try local detection first
    let { productType, source: typeSource } = this.resolveProductTypeLocal(overrides?.productType);

    // If local detection failed → call Gennoctua LLM endpoint
    if (!productType) {
      const title = overrides?.productTitle ?? this.detectProductTitle() ?? undefined;
      const description = this.detectPageDescription() ?? undefined;
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
        recoverable: false,
      });
    }

    return {
      image,
      productType,
      productTypeSource: typeSource,
      productId: overrides?.productId,
      productTitle: overrides?.productTitle ?? this.detectProductTitle() ?? undefined,
      pageUrl: typeof window !== "undefined" ? window.location.href : undefined,
    };
  }

  // ── Product image resolution ────────────────────────────────────────────────

  private async resolveProductImage(manualUrl?: string): Promise<ProductImageContext | null> {
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

  private extractImageFromSelector(selector: string): string | null {
    try {
      const el = document.querySelector<HTMLImageElement | HTMLElement>(selector);
      if (!el) return null;
      if (el instanceof HTMLImageElement) return el.src || el.getAttribute("data-src") || null;
      const img = el.querySelector<HTMLImageElement>("img");
      return img?.src || img?.getAttribute("data-src") || null;
    } catch {
      return null;
    }
  }

  private extractFromStructuredData(): string | null {
    try {
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'));
      for (const script of scripts) {
        const data = JSON.parse(script.textContent || "");
        const type = data["@type"];
        if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
          const image = data.image;
          if (typeof image === "string") return image;
          if (Array.isArray(image) && typeof image[0] === "string") return image[0];
          if (typeof image?.url === "string") return image.url;
        }
      }
    } catch {
      // ignore parse errors
    }
    return null;
  }

  private extractFromDomHeuristic(): string | null {
    const selectors = [
      ".product__image img",
      ".product-image img",
      ".product-photo img",
      "[data-product-image] img",
      ".pdp-image img",
      'img[itemprop="image"]',
      '.gallery__image img[src*="product"]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector<HTMLImageElement>(sel);
        if (el?.src) return el.src;
      } catch {
        // continue
      }
    }
    return null;
  }

  // ── Product type resolution (local) ────────────────────────────────────────

  private resolveProductTypeLocal(manualType?: ProductType): {
    productType: ProductType | null;
    source: ProductContext["productTypeSource"];
  } {
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

  private matchRules(): ProductType | null {
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

  private detectFromPage(): ProductType | null {
    const text = [
      typeof window !== "undefined" ? window.location.href : "",
      document.title,
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
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
  private async detectProductTypeRemote(
    imageUrl: string,
    title?: string,
    description?: string,
  ): Promise<ProductType | null> {
    try {
      const body = await this.api.post("/api/detect-product-type", {
        imageUrl,
        title,
        description,
      }) as { productType?: ProductType; confident?: boolean } | null;

      if (body?.productType && body.confident !== false) {
        return body.productType;
      }
      return null;
    } catch {
      // Endpoint not live yet or network error — silently skip
      return null;
    }
  }

  // ── Page metadata helpers ───────────────────────────────────────────────────

  private detectProductTitle(): string | null {
    return (
      document.querySelector<HTMLElement>("h1")?.textContent?.trim() ??
      document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ??
      null
    );
  }

  private detectPageDescription(): string | null {
    return (
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ??
      document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ??
      null
    );
  }

  // ── SPA support ─────────────────────────────────────────────────────────────

  async refreshContext(overrides?: Parameters<typeof this.getContext>[0]): Promise<ProductContext> {
    return this.getContext(overrides);
  }
}
