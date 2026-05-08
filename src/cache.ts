import { cacheError } from "./errors.js";
import type { SelectedImageAsset, UserImageCategory } from "./types.js";

const DB_NAME = "gennoctua_personalize_v1";
const DB_VERSION = 1;

const STORE = {
  selected_images: "selected_images",
  personalized_results: "personalized_results",
  active_jobs: "active_jobs",
  sdk_metadata: "sdk_metadata",
} as const;

type PersonalizedResultRecord = {
  key: string;
  imageUrl: string;
  cachedAt: number;
  ttlMs: number;
};

type ActiveJobRecord = {
  key: string;
  jobId: string;
  startedAt: number;
};

type SelectedImagesRecord = {
  key: string;
  assets: SelectedImageAsset[];
  cachedAt: number;
  ttlMs: number;
};

type ProfileRecord = {
  key: string;
  assets: SelectedImageAsset[];
  /** hash → GCS URL, populated as background uploads complete */
  profileUrls: Record<string, string>;
  cachedAt: number;
  ttlMs: number;
};

// ─── CacheService ─────────────────────────────────────────────────────────────

export class CacheService {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryFallback: Map<string, unknown> = new Map();
  private useMemoryOnly = false;

  // ── Open ────────────────────────────────────────────────────────────────────

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not available"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        for (const name of Object.values(STORE)) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "key" });
          }
        }
      };

      req.onsuccess = (e) => {
        this.db = (e.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      req.onerror = () => reject(req.error);
    });

    return this.dbPromise.catch((e) => {
      // Fall back to in-memory cache so SDK doesn't break
      this.useMemoryOnly = true;
      console.warn("[personalize-sdk] IndexedDB unavailable, using memory cache:", e);
      return null as unknown as IDBDatabase;
    });
  }

  // ── Generic IDB helpers ─────────────────────────────────────────────────────

  private async idbGet<T>(store: string, key: string): Promise<T | null> {
    if (this.useMemoryOnly) {
      return (this.memoryFallback.get(`${store}:${key}`) as T) ?? null;
    }
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(cacheError(`IDB get failed: ${req.error?.message}`));
    });
  }

  private async idbPut(store: string, record: { key: string; [k: string]: unknown }): Promise<void> {
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

  private async idbDelete(store: string, key: string): Promise<void> {
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

  private async idbClearStore(store: string): Promise<void> {
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

  selectedKey(orgId: string, profileId: string): string {
    return `${orgId}:${profileId}`;
  }

  async getSelectedImages(orgId: string, profileId: string): Promise<SelectedImageAsset[] | null> {
    const record = await this.idbGet<SelectedImagesRecord>(
      STORE.selected_images,
      this.selectedKey(orgId, profileId),
    );
    if (!record) return null;
    if (Date.now() - record.cachedAt > record.ttlMs) {
      await this.idbDelete(STORE.selected_images, record.key);
      return null;
    }
    return record.assets;
  }

  async setSelectedImages(
    orgId: string,
    profileId: string,
    assets: SelectedImageAsset[],
    ttlMs: number,
  ): Promise<void> {
    await this.idbPut(STORE.selected_images, {
      key: this.selectedKey(orgId, profileId),
      assets,
      cachedAt: Date.now(),
      ttlMs,
    });
  }

  // ── Personalized results ────────────────────────────────────────────────────

  resultKey(orgId: string, userImageHash: string, productImageHash: string, productType: string): string {
    return `${orgId}:${userImageHash}:${productImageHash}:${productType}`;
  }

  async getResult(key: string): Promise<string | null> {
    const record = await this.idbGet<PersonalizedResultRecord>(STORE.personalized_results, key);
    if (!record) return null;
    if (Date.now() - record.cachedAt > record.ttlMs) {
      await this.idbDelete(STORE.personalized_results, key);
      return null;
    }
    return record.imageUrl;
  }

  async setResult(key: string, imageUrl: string, ttlMs: number): Promise<void> {
    await this.idbPut(STORE.personalized_results, {
      key,
      imageUrl,
      cachedAt: Date.now(),
      ttlMs,
    });
  }

  // ── Active jobs (for restoration after page refresh) ────────────────────────

  activeJobKey(orgId: string, resultKey: string): string {
    return `${orgId}:${resultKey}`;
  }

  async getActiveJob(key: string): Promise<{ jobId: string; startedAt: number } | null> {
    const record = await this.idbGet<ActiveJobRecord>(STORE.active_jobs, key);
    if (!record) return null;
    return { jobId: record.jobId, startedAt: record.startedAt };
  }

  async setActiveJob(key: string, jobId: string): Promise<void> {
    await this.idbPut(STORE.active_jobs, { key, jobId, startedAt: Date.now() });
  }

  async clearActiveJob(key: string): Promise<void> {
    await this.idbDelete(STORE.active_jobs, key);
  }

  // ── Profile cache ───────────────────────────────────────────────────────────
  // Persists selected assets (blobs stored natively in IndexedDB — no base64
  // conversion needed) + GCS URLs so returning users skip the AI pipeline.

  profileKey(orgId: string): string {
    return `${orgId}:profile`;
  }

  async saveProfile(
    orgId: string,
    assets: SelectedImageAsset[],
    profileUrls: Record<string, string>,
    ttlMs: number,
  ): Promise<void> {
    await this.idbPut(STORE.selected_images, {
      key: this.profileKey(orgId),
      assets,
      profileUrls,
      cachedAt: Date.now(),
      ttlMs,
    });
  }

  async loadProfile(
    orgId: string,
  ): Promise<{ assets: SelectedImageAsset[]; profileUrls: Record<string, string> } | null> {
    const record = await this.idbGet<ProfileRecord>(
      STORE.selected_images,
      this.profileKey(orgId),
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
  async updateProfileUrls(orgId: string, profileUrls: Record<string, string>): Promise<void> {
    const record = await this.idbGet<ProfileRecord>(
      STORE.selected_images,
      this.profileKey(orgId),
    );
    if (!record) return; // profile was cleared or expired — skip
    await this.idbPut(STORE.selected_images, {
      ...record,
      profileUrls: { ...record.profileUrls, ...profileUrls },
    });
  }

  async clearProfile(orgId: string): Promise<void> {
    await this.idbDelete(STORE.selected_images, this.profileKey(orgId));
  }

  // ── Public clear APIs ───────────────────────────────────────────────────────

  async clearSelection(): Promise<void> {
    await this.idbClearStore(STORE.selected_images);
  }

  async clearPersonalization(): Promise<void> {
    await Promise.all([
      this.idbClearStore(STORE.personalized_results),
      this.idbClearStore(STORE.active_jobs),
    ]);
  }

  async clearAll(): Promise<void> {
    await Promise.all(Object.values(STORE).map((s) => this.idbClearStore(s)));
  }
}
