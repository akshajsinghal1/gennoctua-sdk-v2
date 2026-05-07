/**
 * LocalSelectionService
 *
 * Wraps the existing browser AI pipeline (face-api.js + MediaPipe PoseLandmarker)
 * to produce SelectedImageAsset[] from a FileList.
 *
 * Models load lazily from CDN on first call.
 * All logic is adapted from the battle-tested MauiJim pipeline.
 */

import type { SelectedImageAsset, UserImageCategory } from "./types.js";
import { SDKError } from "./errors.js";

// ─── CDN URLs ─────────────────────────────────────────────────────────────────

const FACE_API_CDN = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
const FACE_MODELS_CDN = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/";
const MEDIAPIPE_TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs";
const MEDIAPIPE_TASKS_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

const MAX_IMAGES = 80;

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
      withAgeAndGender: () => Promise<Array<{ age?: number; gender?: string; genderProbability?: number }>>;
    };
  };
};

type PoseDetector = {
  detect: (canvas: HTMLCanvasElement) => {
    landmarks?: Array<Array<{ x: number; y: number; visibility?: number }>>;
  };
};

export type SelectionProgress = {
  phase: "loading_models" | "categorizing" | "ranking" | "complete";
  message: string;
  current?: number;
  total?: number;
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

export function ensurePoseReady(): Promise<PoseDetector> {
  if (!posePromise) {
    posePromise = (async () => {
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

function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name}`)); };
    img.src = url;
  });
}

async function hashFile(file: File): Promise<string> {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function filterValidImages(fileList: FileList | null | undefined): File[] {
  return Array.from(fileList || [])
    .filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name))
    .slice(0, MAX_IMAGES);
}

function point(
  kp: Array<{ x: number; y: number; visibility?: number }>,
  index: number,
  min = 0.2,
): { x: number; y: number } | null {
  const p = kp[index];
  if (!p || (typeof p.visibility === "number" && p.visibility < min)) return null;
  return p;
}

/**
 * Pose score: 1 = full body with ankles (best), 2 = knees visible, 3 = torso only.
 * Returns 0 if single-person pose not detected.
 */
async function getPoseScore(file: File, detector: PoseDetector): Promise<number> {
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
    if (point(kp, 27) && point(kp, 28)) return 1; // ankles — best
    if (point(kp, 25) && point(kp, 26)) return 2; // knees
    return 3; // torso only
  } catch {
    return 0;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function selectImages(
  fileList: FileList | null | undefined,
  onProgress?: (p: SelectionProgress) => void,
): Promise<SelectedImageAsset[]> {
  const files = filterValidImages(fileList);
  if (files.length === 0) {
    throw new SDKError({
      code: "UPLOAD_FAILED",
      message: "No valid image files found.",
      recoverable: true,
    });
  }

  onProgress?.({ phase: "loading_models", message: "Loading AI models..." });
  const [faceapi, pose] = await Promise.all([ensureFaceApiReady(), ensurePoseReady()]);

  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.5 });

  // ── Face categorization ──────────────────────────────────────────────────────
  type Candidate = { file: File; gender: "male" | "female"; age: number; poseScore: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < files.length; i++) {
    onProgress?.({
      phase: "categorizing",
      message: `Scanning faces ${i + 1} of ${files.length}...`,
      current: i + 1,
      total: files.length,
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
      // skip unreadable images
    }
  }

  // ── Pose scoring ─────────────────────────────────────────────────────────────
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    onProgress?.({
      phase: "ranking",
      message: `Ranking photos ${i + 1} of ${candidates.length}...`,
      current: i + 1,
      total: candidates.length,
    });
    try {
      c.poseScore = await getPoseScore(c.file, pose);
    } catch {
      c.poseScore = 0;
    }
  }

  // ── Build SelectedImageAsset[] ───────────────────────────────────────────────
  const results: SelectedImageAsset[] = [];

  // For full-body: pick best pose score per gender (lowest non-zero = full body)
  for (const gender of ["male", "female"] as const) {
    const category: UserImageCategory = gender === "male" ? "male_full_body" : "female_full_body";
    const pool = candidates
      .filter((c) => c.gender === gender && c.poseScore > 0)
      .sort((a, b) => a.poseScore - b.poseScore);
    if (pool[0]) {
      const hash = await hashFile(pool[0].file);
      results.push({
        category,
        imageId: hash,
        blob: pool[0].file,
        hash,
        confidence: 0.85,
        qualityScore: 1 / pool[0].poseScore, // lower score = better
        source: "local_ai",
        createdAt: new Date().toISOString(),
      });
    }
  }

  // For face close-up: any candidate with detected face works (use same file as full-body pick)
  for (const gender of ["male", "female"] as const) {
    const category: UserImageCategory = gender === "male" ? "male_face_closeup" : "female_face_closeup";
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
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Child categories
  for (const gender of ["male", "female"] as const) {
    const bodyCategory: UserImageCategory = "child_full_body";
    const faceCategory: UserImageCategory = gender === "male" ? "child_face_closeup" : "child_face_closeup";
    const pool = candidates.filter((c) => c.gender === gender && c.age < 13);
    if (pool[0]) {
      const hash = await hashFile(pool[0].file);
      const base = {
        imageId: hash,
        blob: pool[0].file,
        hash,
        confidence: 0.75,
        qualityScore: 0.75,
        source: "local_ai" as const,
        createdAt: new Date().toISOString(),
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
