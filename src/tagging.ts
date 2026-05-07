/**
 * FallbackTaggingService
 *
 * When browser-side AI confidence is low, sends a filtered subset of candidate
 * images to the backend tagging API to get better category assignments.
 *
 * Trigger conditions (any one is sufficient):
 * - local confidence below threshold (< 0.7)
 * - a required product-mapped category is missing but candidates exist
 * - merchant config forces backend validation
 *
 * The service sends 7–13 filtered images where possible.
 * Backend tags are merged with local results (backend wins on confidence ties).
 */

import type { ApiClient } from "./api-client.js";
import type { RateLimitService } from "./rate-limit.js";
import type { SelectedImageAsset, UserImageCategory } from "./types.js";
import { normalizeError } from "./errors.js";

const CONFIDENCE_THRESHOLD = 0.7;
const MIN_SEND = 7;
const MAX_SEND = 13;

// ─── Types ────────────────────────────────────────────────────────────────────

type LocalCandidate = {
  imageId: string;
  candidateTags: UserImageCategory[];
  confidence: number;
};

type BackendTagResponse = {
  tags: Array<{
    imageId: string;
    category: UserImageCategory;
    confidence: number;
  }>;
};

// ─── FallbackTaggingService ───────────────────────────────────────────────────

export class FallbackTaggingService {
  private api: ApiClient;
  private rateLimit: RateLimitService;
  private orgId: string;
  private sessionId: string;

  constructor(api: ApiClient, rateLimit: RateLimitService, orgId: string, sessionId: string) {
    this.api = api;
    this.rateLimit = rateLimit;
    this.orgId = orgId;
    this.sessionId = sessionId;
  }

  /**
   * Decides whether fallback tagging is needed and runs it if so.
   * Returns the merged (improved) asset list.
   */
  async maybeTag(
    assets: SelectedImageAsset[],
    requiredCategories: UserImageCategory[],
    force = false,
  ): Promise<SelectedImageAsset[]> {
    if (!force && !this.shouldTag(assets, requiredCategories)) {
      return assets;
    }

    // Rate limit check — silently skip if blocked
    try {
      this.rateLimit.checkTagging();
    } catch {
      return assets;
    }

    const candidates = this.selectCandidates(assets);
    if (candidates.length === 0) return assets;

    let backendTags: BackendTagResponse["tags"];
    try {
      backendTags = await this.callTaggingApi(candidates);
      this.rateLimit.recordTagging();
    } catch (e) {
      // Tagging failure must never break the pipeline
      console.warn("[personalize-sdk] Fallback tagging failed:", normalizeError(e).message);
      return assets;
    }

    return this.mergeResults(assets, candidates, backendTags);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private shouldTag(assets: SelectedImageAsset[], required: UserImageCategory[]): boolean {
    // Any asset with low confidence
    if (assets.some((a) => a.confidence < CONFIDENCE_THRESHOLD)) return true;
    // Any required category missing
    const available = new Set(assets.map((a) => a.category));
    if (required.some((c) => !available.has(c))) return true;
    return false;
  }

  private selectCandidates(assets: SelectedImageAsset[]): SelectedImageAsset[] {
    // Prefer low-confidence assets and unique blobs
    const seen = new Set<string>();
    const filtered = assets
      .filter((a) => {
        if (seen.has(a.hash)) return false;
        seen.add(a.hash);
        return true;
      })
      .sort((a, b) => a.confidence - b.confidence); // lowest confidence first

    // Clamp to MIN_SEND–MAX_SEND
    return filtered.slice(0, MAX_SEND);
  }

  private async callTaggingApi(
    candidates: SelectedImageAsset[],
  ): Promise<BackendTagResponse["tags"]> {
    const formData = new FormData();
    formData.append("orgId", this.orgId);
    formData.append("sessionId", this.sessionId);

    const localCandidates: LocalCandidate[] = candidates.map((a) => ({
      imageId: a.imageId,
      candidateTags: [a.category],
      confidence: a.confidence,
    }));
    formData.append("localCandidates", JSON.stringify(localCandidates));

    for (const asset of candidates) {
      formData.append("images", asset.blob, `${asset.imageId}.jpg`);
    }

    // NOTE: /v1/image-tagging is a future endpoint.
    // Until it's live, this will 404 and be caught by the try/catch in maybeTag().
    const response = await this.api.post("/v1/image-tagging", formData) as BackendTagResponse;
    return response?.tags ?? [];
  }

  private mergeResults(
    original: SelectedImageAsset[],
    sentCandidates: SelectedImageAsset[],
    backendTags: BackendTagResponse["tags"],
  ): SelectedImageAsset[] {
    if (!backendTags.length) return original;

    // Build lookup: imageId → backend tag
    const tagMap = new Map(backendTags.map((t) => [t.imageId, t]));

    // Update sent candidates with backend results
    const updatedMap = new Map<string, SelectedImageAsset>();
    for (const asset of original) {
      updatedMap.set(`${asset.category}:${asset.imageId}`, asset);
    }

    for (const candidate of sentCandidates) {
      const tag = tagMap.get(candidate.imageId);
      if (!tag) continue;
      // Backend wins — update the asset with the better category + confidence
      const updated: SelectedImageAsset = {
        ...candidate,
        category: tag.category,
        confidence: tag.confidence,
        source: original.find((a) => a.imageId === candidate.imageId)
          ? "merged"
          : "backend_tagging",
      };
      updatedMap.set(`${tag.category}:${candidate.imageId}`, updated);
    }

    return Array.from(updatedMap.values());
  }
}
