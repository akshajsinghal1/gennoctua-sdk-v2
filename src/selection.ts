/**
 * selection.ts — v2
 *
 * Improvements over v1:
 * - Front-facing detection (computeFrontFacingDiagnostic, 8-component weighted score)
 * - Proper standing rank: full_body_standing(1) > knee_visible(2) > upper_body(3) > sitting variants
 * - Separate selection logic for full_body (pose-first) vs face_closeup (face clarity-first)
 * - kid_boy / kid_girl are distinct profiles (kid_boy_full_body, kid_boy_face_closeup, etc.)
 * - iOS safe mode: sequential processing instead of parallel
 * - Single-person validation: rejects multi-person frames
 *
 * Models load lazily from CDN on first call (singleton pattern).
 */

import type {
  PersonalizationMode,
  RejectionReasonCode,
  SelectedImageAsset,
  TopRoomCandidate,
  TopRoomCandidatesMap,
  UserImageCategory,
} from "./types.js";
import { SDKError } from "./errors.js";
import { classifyRoom, type RoomType } from "./room-classifier.js";

// ─── CDN URLs ─────────────────────────────────────────────────────────────────

const FACE_API_CDN = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
const FACE_MODELS_CDN = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/";
const MEDIAPIPE_TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs";
const MEDIAPIPE_TASKS_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

const MAX_IMAGES = 80;


// ─── Pose Thresholds (ported from westside production) ────────────────────────

/** Minimum front-facing score to qualify for full-body selection */
const POSE_FRONT_FACING_MIN_SCORE = 80;
/** General keypoint visibility confidence minimum */
const KP_MIN_CONF = 0.16;
/** Higher confidence required for lower-body keypoints (knees, ankles) */
const KP_LOWER_MIN_CONF = 0.28;
/** Max allowed shoulder height difference (normalized) for front-facing check */
const POSE_SHOULDER_LEVEL_MAX = 0.08;
/** Max allowed hip height difference (normalized) for front-facing check */
const POSE_HIP_LEVEL_MAX = 0.08;
/** Max allowed horizontal offset from frame center */
const POSE_CENTER_OFFSET_MAX = 0.16;
/** Minimum full-body height (normalized) to count as standing */
const POSE_MIN_BODY_HEIGHT = 0.46;
/** Minimum normalized Y position for knees to count as visible below waist */
const POSE_MIN_KNEE_Y = 0.70;
/** Minimum normalized Y position for ankles to count as full-body */
const POSE_MIN_ANKLE_Y = 0.82;
/** Minimum normalized shoulder width to detect front-facing */
const POSE_MIN_SHOULDER_WIDTH = 0.12;

// ─── Types ────────────────────────────────────────────────────────────────────

type FaceApi = {
  nets: {
    tinyFaceDetector: { loadFromUri: (uri: string) => Promise<unknown> };
    faceLandmark68TinyNet: { loadFromUri: (uri: string) => Promise<unknown> };
    ageGenderNet: { loadFromUri: (uri: string) => Promise<unknown> };
  };
  TinyFaceDetectorOptions: new (opts: { inputSize: number; scoreThreshold: number }) => unknown;
  detectAllFaces: (
    img: HTMLImageElement,
    opts: unknown,
  ) => {
    withFaceLandmarks: (useTinyModel: boolean) => {
      withAgeAndGender: () => Promise<
        Array<{
          age?: number;
          gender?: string;
          genderProbability?: number;
          detection?: {
            score?: number;
            box?: { width: number; height: number };
            imageWidth?: number;
            imageHeight?: number;
          };
        }>
      >;
    };
  };
};

type PoseDetector = {
  detect: (canvas: HTMLCanvasElement) => {
    landmarks?: Array<Array<{ x: number; y: number; visibility?: number }>>;
  };
};

type Keypoint = { x: number; y: number; visibility?: number };

type PoseAssessment = {
  frontScore: number;
  frontLabel: "front_facing" | "angled" | "side_facing";
  /** 0 = excluded, 1 = full_body_standing (best), 2 = knee_visible_standing,
   *  3 = upper_body_standing, 4 = full_body_sitting, 5 = knee_visible_sitting */
  poseRank: number;
  poseLabel: string;
};

type Candidate = {
  file: File;
  gender: "male" | "female";
  age: number;
  detectionScore: number;
  genderProbability: number;
  /** Face bounding box area as fraction of total image area (0–1).
   *  Higher = face fills more of the frame = better for eyewear/jewellery/makeup. */
  faceAreaRatio: number;
} & PoseAssessment;

export type SelectionProgress = {
  phase: "loading_models" | "categorizing" | "scoring" | "ranking" | "complete";
  message: string;
  current?: number;
  total?: number;
};

/** Top candidate exposed for optional LLM refinement — one entry per ranked photo */
export type TopCandidate = {
  file: File;
  hash: string;
  age: number;
  poseRank: number;
  frontScore: number;
  genderProbability: number;
  detectionScore: number;
  faceAreaRatio: number;
};

/** Top-5 candidates per internal category, ready to send to LLM profile picker */
export type TopCandidatesMap = {
  male:    TopCandidate[];
  female:  TopCandidate[];
  kid_boy: TopCandidate[];
  kid_girl: TopCandidate[];
};

export type SelectionOutput = {
  assets: SelectedImageAsset[];
  /** Per-reason count of why photos were rejected during pipeline processing.
   *  Passed up to SelectionSummary.rejectionReasons (non-zero entries only). */
  rejections: Record<RejectionReasonCode, number>;
  /** Top-5 person candidates per gender/age group for optional LLM refinement. */
  topCandidates: TopCandidatesMap;
  /**
   * Top-5 room candidates per room type for LLM refinement.
   *
   * Flow:
   *   1. YOLO buckets all uploaded images into bedroom / living_room / dining_room.
   *   2. Each bucket is sorted by yoloScore descending (best detection first).
   *   3. Top 5 per bucket are exposed here.
   *   4. Brand sends these to an LLM vision call to pick the single best image
   *      per room type (or confirm the classification).
   *
   * Empty arrays mean no images were confidently bucketed into that room type.
   */
  topRoomCandidates: TopRoomCandidatesMap;
};

// ─── Room type → UserImageCategory mapping ────────────────────────────────────

const ROOM_TYPE_TO_CATEGORY: Record<RoomType, UserImageCategory | null> = {
  bedroom:    "room_bedroom",
  living_room: "room_living_room",
  dining_room: "room_dining_room",
  kitchen:    "room_kitchen",
  bathroom:   "room_bathroom",
  other:      null,
};

// ─── Singletons ───────────────────────────────────────────────────────────────

// Suppress MediaPipe TFLite delegate log that incorrectly routes to console.error
if (typeof window !== "undefined") {
  const _orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes("Created TensorFlow Lite XNNPACK delegate")) return;
    _orig(...args);
  };
}

let faceApiPromise: Promise<FaceApi> | null = null;
let posePromise: Promise<PoseDetector> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)) {
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

export function ensureFaceApiReady(): Promise<FaceApi> {
  if (!faceApiPromise) {
    faceApiPromise = (async () => {
      await loadScript(FACE_API_CDN);
      const faceapi = (window as unknown as { faceapi?: FaceApi }).faceapi;
      if (!faceapi) throw new Error("face-api.js did not initialize");
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_CDN),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODELS_CDN),
        faceapi.nets.ageGenderNet.loadFromUri(FACE_MODELS_CDN),
      ]);
      return faceapi;
    })();
  }
  return faceApiPromise;
}

/**
 * Patch WebAssembly streaming APIs for iOS / iPadOS WebKit compatibility.
 * WebKit does not support streaming WASM compilation — it requires the full
 * ArrayBuffer to be available before compiling. Without this patch, MediaPipe
 * silently fails or hangs on iOS.
 */
function patchWasmStreamingForIOS(): void {
  if (typeof WebAssembly === "undefined") return;
  const isIOS = isIOSDevice();
  const supportsStreaming = typeof (WebAssembly as { compileStreaming?: unknown }).compileStreaming === "function";

  if (!supportsStreaming || isIOS) {
    const wa = WebAssembly as unknown as Record<string, unknown>;

    wa.compileStreaming = async (source: Response | Promise<Response>) => {
      const res = await Promise.resolve(source);
      const buf = await res.arrayBuffer();
      return WebAssembly.compile(buf);
    };

    wa.instantiateStreaming = async (
      source: Response | Promise<Response>,
      imports?: WebAssembly.Imports,
    ) => {
      const res = await Promise.resolve(source);
      const buf = await res.arrayBuffer();
      return WebAssembly.instantiate(buf, imports);
    };
  }
}

export function ensurePoseReady(): Promise<PoseDetector> {
  if (!posePromise) {
    posePromise = (async () => {
      patchWasmStreamingForIOS();
      const { FilesetResolver, PoseLandmarker } = await import(
        /* webpackIgnore: true */ MEDIAPIPE_TASKS_URL as string
      );
      const resolver = await FilesetResolver.forVisionTasks(MEDIAPIPE_TASKS_WASM_URL);
      return PoseLandmarker.createFromOptions(resolver, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "CPU" },
        runningMode: "IMAGE",
        numPoses: 4,
        minPoseDetectionConfidence: 0.25,
        minPosePresenceConfidence: 0.25,
        minTrackingConfidence: 0.25,
      }) as PoseDetector;
    })();
  }
  return posePromise;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Detect iOS/iPadOS — sequential processing mode for WebKit stability */
function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name}`)); };
    img.src = url;
  });
}

function hashFile(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function filterValidImages(fileList: FileList | null | undefined): File[] {
  return Array.from(fileList || [])
    .filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name))
    .slice(0, MAX_IMAGES);
}

/** Get a keypoint if visible above the general confidence threshold */
function pt(kp: Keypoint[], index: number): { x: number; y: number } | null {
  const p = kp[index];
  if (!p || (typeof p.visibility === "number" && p.visibility < KP_MIN_CONF)) return null;
  return p;
}

/** Get a lower-body keypoint with stricter confidence threshold */
function ptLower(kp: Keypoint[], index: number): { x: number; y: number } | null {
  const p = kp[index];
  if (!p || (typeof p.visibility === "number" && p.visibility < KP_LOWER_MIN_CONF)) return null;
  return p;
}

// ─── Front-Facing Detection ───────────────────────────────────────────────────

/**
 * 8-component weighted score for how front-facing a person is.
 * Uses MediaPipe pose keypoints: nose(0), ears(7,8), shoulders(11,12), hips(23,24).
 *
 * Score ≥ 80 → front_facing (qualifies for full-body selection)
 * Score ≥ 45 → angled
 * Score  < 45 → side_facing
 */
function computeFrontFacingDiagnostic(
  kp: Keypoint[],
): { score: number; label: "front_facing" | "angled" | "side_facing" } {
  const nose = pt(kp, 0);
  const leftEar = pt(kp, 7);
  const rightEar = pt(kp, 8);
  const leftShoulder = pt(kp, 11);
  const rightShoulder = pt(kp, 12);
  const leftHip = pt(kp, 23);
  const rightHip = pt(kp, 24);

  // Shoulders are the anchor — without them we can't assess
  if (!leftShoulder || !rightShoulder) {
    return { score: 0, label: "side_facing" };
  }

  const shoulderWidth = Math.abs(leftShoulder.x - rightShoulder.x);
  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;

  // 1. Shoulder width — wider = more front-facing (reference: ~0.25 normalized width)
  const shoulderWidthScore = Math.min(100, (shoulderWidth / 0.25) * 100);

  // 2. Hip width — wider = more front-facing (reference: ~0.18 normalized width)
  let hipWidthScore = 50;
  if (leftHip && rightHip) {
    const hipWidth = Math.abs(leftHip.x - rightHip.x);
    hipWidthScore = Math.min(100, (hipWidth / 0.18) * 100);
  }

  // 3. Shoulder level — tilted shoulders indicate side/angled view
  const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y);
  const shoulderLevelScore = Math.max(0, 100 - (shoulderTilt / POSE_SHOULDER_LEVEL_MAX) * 100);

  // 4. Hip level — same logic as shoulders
  let hipLevelScore = 50;
  if (leftHip && rightHip) {
    const hipTilt = Math.abs(leftHip.y - rightHip.y);
    hipLevelScore = Math.max(0, 100 - (hipTilt / POSE_HIP_LEVEL_MAX) * 100);
  }

  // 5. Center offset — person should be roughly centered in frame
  const centerOffset = Math.abs(shoulderMidX - 0.5);
  const centerScore = Math.max(0, 100 - (centerOffset / POSE_CENTER_OFFSET_MAX) * 100);

  // 6. Torso symmetry — shoulder mid and hip mid should align vertically
  let torsoSymmetryScore = 50;
  if (leftHip && rightHip) {
    const hipMidX = (leftHip.x + rightHip.x) / 2;
    const torsoLean = Math.abs(shoulderMidX - hipMidX);
    torsoSymmetryScore = Math.max(0, 100 - (torsoLean / 0.08) * 100);
  }

  // 7. Width balance — left and right shoulders equidistant from frame center
  const leftDist = Math.abs(leftShoulder.x - 0.5);
  const rightDist = Math.abs(rightShoulder.x - 0.5);
  const sideRatio = leftDist > rightDist
    ? leftDist / Math.max(rightDist, 0.001)
    : rightDist / Math.max(leftDist, 0.001);
  const widthBalanceScore = Math.max(0, 100 - (sideRatio - 1) * 100);

  // 8. Head symmetry — nose centered between ears = front-facing head
  let headScore = 50;
  if (nose && leftEar && rightEar) {
    const earMidX = (leftEar.x + rightEar.x) / 2;
    const earSpan = Math.abs(leftEar.x - rightEar.x);
    const noseDev = Math.abs(nose.x - earMidX);
    headScore = earSpan > 0.01
      ? Math.max(0, 100 - (noseDev / Math.max(earSpan * 0.3, 0.02)) * 100)
      : 50;
  }

  const score = Math.round(
    shoulderWidthScore  * 0.16 +
    hipWidthScore       * 0.12 +
    shoulderLevelScore  * 0.14 +
    hipLevelScore       * 0.12 +
    centerScore         * 0.14 +
    torsoSymmetryScore  * 0.18 +
    widthBalanceScore   * 0.06 +
    headScore           * 0.08,
  );

  const label =
    score >= POSE_FRONT_FACING_MIN_SCORE ? "front_facing" :
    score >= 45 ? "angled" : "side_facing";

  return { score, label };
}

// ─── Pose Ranking ─────────────────────────────────────────────────────────────

/**
 * Combines front-facing check with body visibility to produce a rank.
 * Only photos with frontScore ≥ 80 get a non-zero rank (can enter full-body selection).
 *
 * Rank 1 (best) → full_body_standing  — ankles visible, standing geometry
 * Rank 2        → knee_visible_standing — knees visible, standing geometry
 * Rank 3        → upper_body_standing  — torso only, no knees
 * Rank 4        → full_body_sitting    — ankles visible but not standing
 * Rank 5        → knee_visible_sitting — knees visible but not standing
 * Rank 0        → excluded (not front-facing or insufficient keypoints)
 */
function rankPoseCandidate(kp: Keypoint[]): PoseAssessment {
  const { score: frontScore, label: frontLabel } = computeFrontFacingDiagnostic(kp);

  // Must be front-facing to qualify for full-body
  if (frontScore < POSE_FRONT_FACING_MIN_SCORE) {
    return { frontScore, frontLabel, poseRank: 0, poseLabel: "not_front_facing" };
  }

  const ls = pt(kp, 11); const rs = pt(kp, 12); // shoulders
  const lh = pt(kp, 23); const rh = pt(kp, 24); // hips

  if (!ls || !rs || !lh || !rh) {
    return { frontScore, frontLabel, poseRank: 0, poseLabel: "insufficient_keypoints" };
  }

  // Check shoulder width minimum
  if (Math.abs(ls.x - rs.x) < POSE_MIN_SHOULDER_WIDTH) {
    return { frontScore, frontLabel, poseRank: 0, poseLabel: "shoulder_too_narrow" };
  }

  // Lower body keypoints (stricter visibility threshold)
  const lk = ptLower(kp, 25); const rk = ptLower(kp, 26); // knees
  const la = ptLower(kp, 27); const ra = ptLower(kp, 28); // ankles

  const hasKnees = !!(lk && rk);
  const hasAnkles = !!(la && ra);

  // Determine bottom-most point for body height calculation
  const bodyTop = Math.min(ls.y, rs.y);
  const bodyBottom = hasAnkles
    ? Math.max(la!.y, ra!.y)
    : hasKnees
    ? Math.max(lk!.y, rk!.y)
    : Math.max(lh.y, rh.y);
  const bodyHeight = bodyBottom - bodyTop;

  // Standing = correct y-ordering + sufficient body height
  // Deliberately NO absolute y-position thresholds — a person standing with
  // breathing room below their feet is still standing, not sitting.
  const isStanding =
    bodyHeight >= POSE_MIN_BODY_HEIGHT &&
    ls.y < lh.y && rs.y < rh.y &&                     // shoulders above hips
    (!hasKnees || (lh.y < lk!.y && rh.y < rk!.y));    // hips above knees

  if (hasAnkles && isStanding) return { frontScore, frontLabel, poseRank: 1, poseLabel: "full_body_standing" };
  if (hasKnees && isStanding)  return { frontScore, frontLabel, poseRank: 2, poseLabel: "knee_visible_standing" };
  if (!hasKnees && !hasAnkles) return { frontScore, frontLabel, poseRank: 3, poseLabel: "upper_body_standing" };
  if (hasAnkles)               return { frontScore, frontLabel, poseRank: 4, poseLabel: "full_body_sitting" };
  if (hasKnees)                return { frontScore, frontLabel, poseRank: 5, poseLabel: "knee_visible_sitting" };

  return { frontScore, frontLabel, poseRank: 3, poseLabel: "upper_body" };
}

// ─── Pose Assessment ──────────────────────────────────────────────────────────

async function getPoseAssessment(file: File, detector: PoseDetector): Promise<PoseAssessment> {
  const fallback: PoseAssessment = { frontScore: 0, frontLabel: "side_facing", poseRank: 0, poseLabel: "not_detected" };
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

    // No pose detected at all
    if (!result?.landmarks?.length) return fallback;

    // Reject multi-person frames — distinct label so rejections can be counted separately
    if (result.landmarks.length > 1) {
      return { frontScore: 0, frontLabel: "side_facing", poseRank: 0, poseLabel: "multiple_poses" };
    }

    return rankPoseCandidate(result.landmarks[0]);
  } catch {
    return fallback;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function selectImages(
  fileList: FileList | null | undefined,
  onProgress?: (p: SelectionProgress) => void,
  personalizationMode?: PersonalizationMode[],
): Promise<SelectionOutput> {
  const files = filterValidImages(fileList);
  if (files.length === 0) {
    throw new SDKError({
      code: "UPLOAD_FAILED",
      message: "No valid image files found.",
      recoverable: true,
    });
  }

  // ── Rejection counters — tracked throughout the pipeline ──────────────────
  const rejections: Record<RejectionReasonCode, number> = {
    no_face_detected:      0,
    multiple_people:       0,
    low_gender_confidence: 0,
    not_front_facing:      0,
    no_full_body:          0,
  };

  // ── Derive which pipelines to run based on personalizationMode ──────────────
  // "all" or not provided → run both pipelines on every photo
  // "furniture" only      → skip face detection, run room classifier on all photos
  // anything else         → run face detection, skip room classifier
  const modes = personalizationMode ?? ["all"];
  const hasAll      = modes.includes("all");
  const hasFurniture = modes.includes("furniture");
  const hasPersonMode = modes.some(m => m !== "furniture" && m !== "all");

  const needsFaceDetection  = hasAll || hasPersonMode || (!hasFurniture && !hasPersonMode);
  const needsRoomClassifier = hasAll || hasFurniture;

  const isIOS = isIOSDevice();
  void isIOS; // used implicitly by sequential loop pattern below

  // Load only the models we actually need
  onProgress?.({ phase: "loading_models", message: "Loading AI models..." });
  const [faceapi, pose] = needsFaceDetection
    ? await Promise.all([ensureFaceApiReady(), ensurePoseReady()])
    : [null, null];

  // ── Phase 1: Face detection → person candidates ───────────────────────────
  // Skipped entirely for furniture-only brands — saves time and memory since
  // users upload room photos where faces are irrelevant.

  type PreCandidate = {
    file: File;
    gender: "male" | "female";
    age: number;
    detectionScore: number;
    genderProbability: number;
    faceAreaRatio: number;
  };

  const preCandidates: PreCandidate[] = [];

  if (needsFaceDetection && faceapi) {
    const faceOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.5 });

    // Process in parallel batches of 3 — overlaps image I/O loading while
    // TF.js runs inference. Safe on all platforms including iOS (face-api.js
    // uses TensorFlow.js, not WebAssembly streaming).
    const FACE_BATCH_SIZE = 3;
    let processed = 0;

    for (let i = 0; i < files.length; i += FACE_BATCH_SIZE) {
      const batch = files.slice(i, i + FACE_BATCH_SIZE);

      onProgress?.({
        phase: "categorizing",
        message: `Scanning faces ${processed + 1}–${Math.min(processed + batch.length, files.length)} of ${files.length}...`,
        current: processed,
        total: files.length,
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
        }),
      );

      for (const { file, faces } of batchResults) {
        if (faces.length === 0) { rejections.no_face_detected++; continue; }
        if (faces.length !== 1) { rejections.multiple_people++;  continue; } // group photo

        const face = faces[0];
        const gender = face.gender === "male" || face.gender === "female" ? face.gender : null;
        if (!gender || (face.genderProbability ?? 0) < 0.7) { rejections.low_gender_confidence++; continue; }

        // Face area ratio — how much of the frame the face occupies.
        // box.width/height are in pixels; imageWidth/imageHeight give frame size.
        const box = face.detection?.box;
        const iw = face.detection?.imageWidth ?? 1;
        const ih = face.detection?.imageHeight ?? 1;
        const faceAreaRatio = box
          ? (box.width * box.height) / (iw * ih)
          : 0;

        preCandidates.push({
          file,
          gender,
          age: typeof face.age === "number" ? face.age : 25,
          detectionScore: face.detection?.score ?? 0.5,
          genderProbability: face.genderProbability ?? 0,
          faceAreaRatio,
        });
      }

      processed += batch.length;
    }
  }

  // ── Phase 2: Pose scoring ─────────────────────────────────────────────────

  const candidates: Candidate[] = [];

  if (needsFaceDetection && pose) {
    for (let i = 0; i < preCandidates.length; i++) {
      onProgress?.({
        phase: "scoring",
        message: `Scoring poses ${i + 1} of ${preCandidates.length}...`,
        current: i + 1,
        total: preCandidates.length,
      });

      const assessment = await getPoseAssessment(preCandidates[i].file, pose);

      // Track pose-level rejections
      if (assessment.poseLabel === "multiple_poses") {
        rejections.multiple_people++;
      } else if (assessment.poseLabel === "not_front_facing") {
        rejections.not_front_facing++;
      } else if (
        assessment.poseLabel === "insufficient_keypoints" ||
        assessment.poseLabel === "shoulder_too_narrow"
      ) {
        rejections.no_full_body++;
      }

      candidates.push({ ...preCandidates[i], ...assessment });
    }
  }

  // ── DEBUG: log all candidate scores ──────────────────────────────────────
  if (candidates.length > 0) {
    console.table(candidates.map((c) => ({
      file:              c.file.name,
      gender:            c.gender,
      age:               Math.round(c.age),
      genderProb:        +c.genderProbability.toFixed(3),
      detectionScore:    +c.detectionScore.toFixed(3),
      faceAreaRatio:     +c.faceAreaRatio.toFixed(4),
      frontScore:        +c.frontScore.toFixed(1),
      poseLabel:         c.poseLabel,
      poseRank:          c.poseRank,
      passesFullBody:    c.frontScore >= POSE_FRONT_FACING_MIN_SCORE && c.poseRank > 0,
      passesFaceCloseup: c.frontScore >= POSE_FRONT_FACING_MIN_SCORE,
    })));
  }

  // ── Phase 2b: Room classification ────────────────────────────────────────
  // Runs on ALL photos (not just no-face ones) when furniture mode is active.
  // A photo with a person in front of a bedroom still classifies correctly
  // because Places365 reads scene context, not the foreground subject.
  // Skipped entirely for fashion/eyewear-only brands — avoids downloading
  // the 50MB ONNX model when it will never be needed.

  type RoomCandidate = {
    file: File;
    roomType: RoomType;
    confidence: number;
    yoloScore: number;
    topLabel: string;
  };

  const roomCandidates: RoomCandidate[] = [];

  if (needsRoomClassifier) {
    onProgress?.({
      phase: "scoring",
      message: `Classifying room photos (${files.length} image${files.length > 1 ? "s" : ""})...`,
      current: 0,
      total: files.length,
    });

    // Collect ALL results for debug logging (not just isRoom=true)
    type RoomDebugRow = {
      file: string; roomType: string; isRoom: boolean;
      confidence: number; yoloScore: number; topLabel: string;
    };
    const roomDebugRows: RoomDebugRow[] = [];

    for (let i = 0; i < files.length; i++) {
      const result = await classifyRoom(files[i]);
      roomDebugRows.push({
        file:       files[i].name,
        roomType:   result.roomType,
        isRoom:     result.isRoom,
        confidence: +result.confidence.toFixed(3),
        yoloScore:  +result.yoloScore.toFixed(2),
        topLabel:   result.label,
      });
      if (result.isRoom) {
        roomCandidates.push({
          file:       files[i],
          roomType:   result.roomType,
          confidence: result.confidence,
          yoloScore:  result.yoloScore,
          topLabel:   result.label,
        });
      }
      onProgress?.({
        phase: "scoring",
        message: `Classifying room photos...`,
        current: i + 1,
        total: files.length,
      });
    }

    // ── DEBUG: log all room scores ───────────────────────────────────────────
    if (roomDebugRows.length > 0) {
      console.table(roomDebugRows);
    }
  }

  // ── Phase 3: Build SelectedImageAsset[] ───────────────────────────────────

  const results: SelectedImageAsset[] = [];
  const now = new Date().toISOString();

  // Person assets — only built when face detection ran
  if (needsFaceDetection) {
  // Full body — must be front-facing AND have at least some body visible (rank 1-3 for standing)
  for (const gender of ["male", "female"] as const) {
    const category: UserImageCategory = gender === "male" ? "male_full_body" : "female_full_body";

    const pool = candidates
      .filter((c) => c.gender === gender && c.frontScore >= POSE_FRONT_FACING_MIN_SCORE && c.poseRank > 0)
      .sort((a, b) =>
        // Primary: lower rank number = better pose
        a.poseRank - b.poseRank ||
        // Secondary: higher front score
        b.frontScore - a.frontScore ||
        // Tertiary: higher gender confidence
        b.genderProbability - a.genderProbability,
      );

    if (pool[0]) {
      const hash = hashFile(pool[0].file);
      results.push({
        category,
        imageId: hash,
        blob: pool[0].file,
        hash,
        confidence: Math.min(0.95, 0.7 + pool[0].genderProbability * 0.2),
        qualityScore: pool[0].poseRank === 1 ? 1.0 : pool[0].poseRank === 2 ? 0.85 : 0.7,
        source: "local_ai",
        createdAt: now,
      });
    }
  }

  // Face closeup — prioritise front-facing + largest face area
  // poseRank intentionally excluded — rank 0 is ambiguous (could be best selfie or bad photo)
  // faceAreaRatio captures "how close/zoomed in" better than poseRank for face categories
  for (const gender of ["male", "female"] as const) {
    const category: UserImageCategory = gender === "male" ? "male_face_closeup" : "female_face_closeup";

    const pool = candidates
      .filter((c) => c.gender === gender && c.age >= 13 && c.frontScore >= POSE_FRONT_FACING_MIN_SCORE)
      .sort((a, b) =>
        b.frontScore - a.frontScore ||
        b.faceAreaRatio - a.faceAreaRatio ||
        b.genderProbability - a.genderProbability ||
        b.detectionScore - a.detectionScore
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
        createdAt: now,
      });
    }
  }

  // Children — separated by gender (kid_boy and kid_girl are distinct profiles)
  const kidByCandidates: Record<"kid_boy" | "kid_girl", Candidate[]> = {
    kid_boy:  candidates.filter((c) => c.age < 13 && c.gender === "male"),
    kid_girl: candidates.filter((c) => c.age < 13 && c.gender === "female"),
  };

  for (const [kidGender, kidCandidates] of Object.entries(kidByCandidates) as ["kid_boy" | "kid_girl", Candidate[]][]) {
    if (kidCandidates.length === 0) continue;

    const fullBodyCat: UserImageCategory = kidGender === "kid_boy" ? "kid_boy_full_body"    : "kid_girl_full_body";
    const faceCat:     UserImageCategory = kidGender === "kid_boy" ? "kid_boy_face_closeup" : "kid_girl_face_closeup";

    // Full body: best standing front-facing kid
    const bodyPool = kidCandidates
      .filter((c) => c.frontScore >= POSE_FRONT_FACING_MIN_SCORE && c.poseRank > 0)
      .sort((a, b) => a.poseRank - b.poseRank || b.frontScore - a.frontScore);

    const bodyPick = bodyPool[0] ?? [...kidCandidates].sort((a, b) => b.genderProbability - a.genderProbability)[0];
    if (bodyPick) {
      const hash = hashFile(bodyPick.file);
      results.push({
        category: fullBodyCat,
        imageId: hash,
        blob: bodyPick.file,
        hash,
        confidence: 0.75,
        qualityScore: bodyPool[0] ? (bodyPick.poseRank === 1 ? 1.0 : 0.8) : 0.6,
        source: "local_ai",
        createdAt: now,
      });
    }

    // Face closeup: front-facing first, then largest face area
    const facePick = [...kidCandidates]
      .filter((c) => c.frontScore >= POSE_FRONT_FACING_MIN_SCORE)
      .sort((a, b) =>
        b.frontScore - a.frontScore ||
        b.faceAreaRatio - a.faceAreaRatio ||
        b.genderProbability - a.genderProbability ||
        b.detectionScore - a.detectionScore
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
        createdAt: now,
      });
    }
  }

  } // end needsFaceDetection

  // ── Room photos: bucket by type, sort by YOLO score, pick best for asset ─────
  //
  // Strategy:
  //   1. Group all detected room photos by room type.
  //   2. Sort each bucket by yoloScore descending (strongest detection first).
  //   3. The top-1 from each bucket becomes the SelectedImageAsset (immediate use).
  //   4. Top-5 from each bucket are exposed as topRoomCandidates for LLM refinement.
  //
  // The brand's integration layer takes topRoomCandidates, sends them to an LLM
  // vision call (max 3 calls — one per room type), and then calls
  // sdk.setRefinedRoomImage(roomType, file) to replace the initial selection.

  const TOP_ROOM_COUNT = 5;
  const ROOM_TYPES_OF_INTEREST: Array<"bedroom" | "living_room" | "dining_room"> = [
    "bedroom", "living_room", "dining_room",
  ];

  // Build sorted buckets
  const roomBuckets = new Map<RoomType, RoomCandidate[]>();
  for (const rc of roomCandidates) {
    if (!roomBuckets.has(rc.roomType)) roomBuckets.set(rc.roomType, []);
    roomBuckets.get(rc.roomType)!.push(rc);
  }
  // Sort each bucket best-first
  for (const bucket of roomBuckets.values()) {
    bucket.sort((a, b) => b.yoloScore - a.yoloScore);
  }

  // Emit one SelectedImageAsset per room type (the top candidate from each bucket)
  for (const [roomType, bucket] of roomBuckets) {
    const category = ROOM_TYPE_TO_CATEGORY[roomType];
    if (!category || bucket.length === 0) continue;
    const best = bucket[0];
    const hash = hashFile(best.file);
    results.push({
      category,
      imageId:      hash,
      blob:         best.file,
      hash,
      confidence:   Math.min(0.95, best.confidence),
      qualityScore: best.confidence,
      source:       "local_ai",
      createdAt:    now,
    });
  }

  // Build topRoomCandidates — top-5 per room type for LLM refinement
  const toTopRoomCandidate = (rc: RoomCandidate): TopRoomCandidate => ({
    file:       rc.file,
    hash:       hashFile(rc.file),
    yoloScore:  rc.yoloScore,
    confidence: rc.confidence,
    topLabel:   rc.topLabel,
  });

  const topRoomCandidates: TopRoomCandidatesMap = {
    bedroom:     (roomBuckets.get("bedroom")     ?? []).slice(0, TOP_ROOM_COUNT).map(toTopRoomCandidate),
    living_room: (roomBuckets.get("living_room") ?? []).slice(0, TOP_ROOM_COUNT).map(toTopRoomCandidate),
    dining_room: (roomBuckets.get("dining_room") ?? []).slice(0, TOP_ROOM_COUNT).map(toTopRoomCandidate),
  };

  void ROOM_TYPES_OF_INTEREST; // used for typing reference

  // ── Phase 4: Build top-5 per category for optional LLM refinement ────────────

  const toTopCandidate = (c: Candidate): TopCandidate => ({
    file: c.file,
    hash: hashFile(c.file),
    age: c.age,
    poseRank: c.poseRank,
    frontScore: c.frontScore,
    genderProbability: c.genderProbability,
    detectionScore: c.detectionScore,
    faceAreaRatio: c.faceAreaRatio,
  });

  const adultSort = (a: Candidate, b: Candidate) =>
    a.poseRank - b.poseRank || b.frontScore - a.frontScore || b.genderProbability - a.genderProbability;

  const topCandidates: TopCandidatesMap = {
    male:     candidates.filter(c => c.gender === "male"   && c.age >= 13).sort(adultSort).slice(0, 5).map(toTopCandidate),
    female:   candidates.filter(c => c.gender === "female" && c.age >= 13).sort(adultSort).slice(0, 5).map(toTopCandidate),
    kid_boy:  candidates.filter(c => c.gender === "male"   && c.age <  13).sort(adultSort).slice(0, 5).map(toTopCandidate),
    kid_girl: candidates.filter(c => c.gender === "female" && c.age <  13).sort(adultSort).slice(0, 5).map(toTopCandidate),
  };

  onProgress?.({ phase: "complete", message: "Selection complete." });
  return { assets: results, topCandidates, topRoomCandidates, rejections };
}
