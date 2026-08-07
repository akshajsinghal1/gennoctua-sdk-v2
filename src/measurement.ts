/**
 * measurement.ts — v0.2
 *
 * Single-scan handoff: cluster + pick body/face shortlists from scanIndex
 * (scores from ingest — no second ML pass).
 *
 * Front+side pairing for measure_fs is planned for a later SDK version.
 */

import type { ScanIndexEntry, MeasurementCluster, ProfileMeasurementShortlists } from "./types.js";

const FACE_CLUSTER_THRESHOLD = 0.55;
const BODY_SIZING_FRONT_MIN = 80;
const BODY_SIZING_FRONT_SOFT = 45;
const FACE_SIZING_FRONT_MIN = 70;
const FACE_SIZING_FRONT_SOFT = 45;
const DEFAULT_BODY_LIMIT = 3;
const DEFAULT_FACE_LIMIT = 5;

export type MeasurementPickOptions = {
  bodyLimit?: number;
  faceLimit?: number;
  /** Map profile asset hash → profileKey (female, male, kid_boy, kid_girl) */
  profileHashes?: Record<string, string>;
};

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function averageDescriptor(members: ScanIndexEntry[]): number[] {
  if (!members.length) return [];
  const len = members[0].faceDescriptor?.length ?? 0;
  if (!len) return [];
  const out = new Array<number>(len).fill(0);
  let count = 0;
  for (const m of members) {
    if (!m.faceDescriptor?.length) continue;
    count++;
    for (let i = 0; i < len; i++) out[i] += m.faceDescriptor[i];
  }
  if (!count) return [];
  for (let i = 0; i < len; i++) out[i] /= count;
  return out;
}

/** Greedy face clustering — same algorithm as westside app.js clusterPhotosByFace. */
export function clusterScanIndex(scanIndex: ScanIndexEntry[]): MeasurementCluster[] {
  const eligible = scanIndex.filter((e) => e.faceDescriptor?.length);
  const sorted = [...eligible].sort((a, b) => a.photoId.localeCompare(b.photoId));
  const clusters: MeasurementCluster[] = [];

  for (const entry of sorted) {
    const desc = entry.faceDescriptor!;
    let matched: MeasurementCluster | null = null;
    let bestDist = Infinity;
    for (const cluster of clusters) {
      const d = euclideanDistance(desc, cluster.centroid);
      if (d < FACE_CLUSTER_THRESHOLD && d < bestDist) {
        bestDist = d;
        matched = cluster;
      }
    }
    if (matched) {
      matched.members.push(entry);
      matched.centroid = averageDescriptor(matched.members);
    } else {
      clusters.push({
        id: clusters.length,
        members: [entry],
        centroid: [...desc],
      });
    }
  }
  return clusters;
}

type ScoredBodyRow = ScanIndexEntry & { tier?: string };
type ScoredFaceRow = ScanIndexEntry & {
  portraitScore: number;
  faceRank: number;
  tier?: string;
};

function sortBodyRows(rows: ScoredBodyRow[]): ScoredBodyRow[] {
  return [...rows].sort((a, b) => {
    if (a.poseRank !== b.poseRank) {
      if (a.poseRank === 0) return 1;
      if (b.poseRank === 0) return -1;
      return a.poseRank - b.poseRank;
    }
    return b.frontScore - a.frontScore;
  });
}

function selectBodyPhotos(rows: ScanIndexEntry[], limit: number): { picked: File[]; tier: string } {
  const eligible = rows.filter((r) => r.poseRank > 0);
  const strict = eligible.filter(
    (r) => r.frontScore >= BODY_SIZING_FRONT_MIN && r.poseRank >= 1 && r.poseRank <= 2,
  );
  const frontOnly = eligible.filter((r) => r.frontScore >= BODY_SIZING_FRONT_MIN);
  const soft = eligible.filter((r) => r.frontScore >= BODY_SIZING_FRONT_SOFT);

  let tier = "none";
  let pool: ScoredBodyRow[] = [];
  if (strict.length) {
    tier = "strict_full_body";
    pool = sortBodyRows(strict);
  } else if (frontOnly.length) {
    tier = "fallback_front_any_pose";
    pool = sortBodyRows(frontOnly);
  } else if (soft.length) {
    tier = "fallback_soft_front";
    pool = sortBodyRows(soft);
  }

  const pickedRows = pool.slice(0, limit);
  const pickedIds = new Set(pickedRows.map((r) => r.photoId));

  if (pickedRows.length < limit) {
    for (const source of [sortBodyRows(frontOnly), sortBodyRows(soft), sortBodyRows(eligible)]) {
      for (const row of source) {
        if (pickedRows.length >= limit) break;
        if (pickedIds.has(row.photoId)) continue;
        pickedRows.push(row);
        pickedIds.add(row.photoId);
      }
      if (pickedRows.length >= limit) break;
    }
    if (pickedRows.length > pool.length && tier !== "none") tier = `${tier}+backfill`;
  }

  return { picked: pickedRows.map((r) => r.blob), tier };
}

function scoreFaceRow(entry: ScanIndexEntry): ScoredFaceRow {
  const front = entry.frontScore;
  if (entry.faceAreaRatio < 0.04) {
    return { ...entry, portraitScore: front, faceRank: 0 };
  }
  const portraitScore = Math.round(front * 0.55 + Math.min(100, entry.faceAreaRatio * 400) * 0.45);

  if (entry.poseRank >= 1 && entry.poseRank <= 2) {
    if (entry.faceAreaRatio >= 0.07 && front >= FACE_SIZING_FRONT_SOFT) {
      return {
        ...entry,
        portraitScore: Math.max(portraitScore, Math.round(front * 0.88)),
        faceRank: front >= FACE_SIZING_FRONT_MIN ? 5 : 4,
      };
    }
    return { ...entry, portraitScore: Math.round(portraitScore * 0.55), faceRank: 1 };
  }
  if (entry.poseRank === 3 && portraitScore >= FACE_SIZING_FRONT_MIN) {
    return { ...entry, portraitScore, faceRank: 4 };
  }
  if (portraitScore >= FACE_SIZING_FRONT_MIN) {
    return { ...entry, portraitScore, faceRank: 3 };
  }
  if (portraitScore >= FACE_SIZING_FRONT_SOFT) {
    return { ...entry, portraitScore, faceRank: 2 };
  }
  return { ...entry, portraitScore, faceRank: 0 };
}

function sortFaceRows(rows: ScoredFaceRow[]): ScoredFaceRow[] {
  return [...rows].sort((a, b) => {
    if (a.faceRank !== b.faceRank) {
      if (a.faceRank === 0) return 1;
      if (b.faceRank === 0) return -1;
      return b.faceRank - a.faceRank;
    }
    return b.portraitScore - a.portraitScore;
  });
}

function selectFacePhotos(rows: ScanIndexEntry[], limit: number): { picked: File[]; tier: string } {
  const scored = rows.map(scoreFaceRow);
  const eligible = scored.filter((r) => r.faceRank > 0);
  const strict = eligible.filter((r) => r.faceRank >= 3 && r.portraitScore >= FACE_SIZING_FRONT_MIN);
  const frontal = eligible.filter((r) => r.portraitScore >= FACE_SIZING_FRONT_MIN);
  const soft = eligible.filter((r) => r.portraitScore >= FACE_SIZING_FRONT_SOFT);

  let tier = "none";
  let pool: ScoredFaceRow[] = [];
  if (strict.length) {
    tier = "strict_portrait";
    pool = sortFaceRows(strict);
  } else if (frontal.length) {
    tier = "frontal_portrait";
    pool = sortFaceRows(frontal);
  } else if (soft.length) {
    tier = "soft_frontal";
    pool = sortFaceRows(soft);
  }

  let picked = pool.slice(0, limit);

  if (!picked.length && rows.length === 1) {
    picked = scored;
    tier = "single_photo";
  }

  return { picked: picked.map((r) => r.blob), tier };
}

function findClusterForHash(
  clusters: MeasurementCluster[],
  hash: string | undefined,
): MeasurementCluster | null {
  if (!hash) return null;
  return (
    clusters.find((c) => c.members.some((m) => m.hash === hash)) ?? null
  );
}

function profileKeyForEntry(entry: ScanIndexEntry): string {
  if (entry.age < 13) return entry.gender === "male" ? "kid_boy" : "kid_girl";
  return entry.gender;
}

/** Build per-profile body + face shortlists from scanIndex (no re-inference). */
export function pickMeasurementShortlists(
  scanIndex: ScanIndexEntry[],
  options: MeasurementPickOptions = {},
): ProfileMeasurementShortlists {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const faceLimit = options.faceLimit ?? DEFAULT_FACE_LIMIT;
  const clusters = clusterScanIndex(scanIndex);
  const out: ProfileMeasurementShortlists = {};

  const profileKeys = ["female", "male", "kid_boy", "kid_girl"] as const;

  for (const profileKey of profileKeys) {
    const assetHash = Object.entries(options.profileHashes ?? {}).find(
      ([, k]) => k === profileKey,
    )?.[0];

    let members: ScanIndexEntry[] = [];
    const cluster = findClusterForHash(clusters, assetHash);
    if (cluster) {
      members = cluster.members;
    } else {
      members = scanIndex.filter((e) => profileKeyForEntry(e) === profileKey);
    }

    if (!members.length) continue;

    const body = selectBodyPhotos(members, bodyLimit);
    const face = selectFacePhotos(members, faceLimit);

    out[profileKey] = {
      bodyPhotos: body.picked,
      facePhotos: face.picked,
      bodyTier: body.tier,
      faceTier: face.tier,
      clusterId: cluster?.id ?? null,
    };
  }

  return out;
}

export function buildScanIndexFromCandidates(
  candidates: Array<{
    file: File;
    gender: "male" | "female";
    age: number;
    detectionScore: number;
    genderProbability: number;
    faceAreaRatio: number;
    frontScore: number;
    frontLabel: string;
    poseRank: number;
    poseLabel: string;
    faceDescriptor?: Float32Array | number[];
  }>,
): ScanIndexEntry[] {
  const now = new Date().toISOString();
  return candidates.map((c, i) => {
    const hash = `${c.file.name}-${c.file.size}-${c.file.lastModified}`;
    return {
      photoId: `scan_${i}_${hash}`,
      fileName: c.file.name,
      hash,
      blob: c.file,
      gender: c.gender,
      age: c.age,
      genderProbability: c.genderProbability,
      detectionScore: c.detectionScore,
      faceAreaRatio: c.faceAreaRatio,
      frontScore: c.frontScore,
      frontLabel: c.frontLabel,
      poseRank: c.poseRank,
      poseLabel: c.poseLabel,
      faceDescriptor: c.faceDescriptor
        ? Array.from(c.faceDescriptor)
        : undefined,
      passesFullBody: c.frontScore >= BODY_SIZING_FRONT_MIN && c.poseRank > 0 && c.poseRank <= 2,
      passesFaceCloseup: c.frontScore >= BODY_SIZING_FRONT_MIN,
      scannedAt: now,
    };
  });
}
