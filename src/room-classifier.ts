/**
 * room-classifier.ts — YOLOv8n ONNX object-detection room classifier
 *
 * Ports the Android SDK RoomInference.infer() scoring logic to the web,
 * upgraded from YOLOv3-tiny to YOLOv8n for significantly stronger detection.
 *
 * Scoring rules (tuned against real home photo dataset):
 *   "bed"          → bedroom      (+2.0, +1.0 bonus if conf > 50%)
 *   "couch"        → living_room  (+2.0 if area ≥ 8%, else +1.5)
 *   "tv"           → living_room  (+1.5)
 *   "chair"        → living_room  (+0.8) when no dining table present
 *                  → dining_room  (+0.5) when dining table also detected
 *   "dining table" → dining_room  (+2.0 if area ≥ 8%, +1.0 if area ≥ 3%)
 *
 * Anti-false-positive rules:
 *   - If couch confidence > bed confidence × 0.95 → bedroomScore = 0
 *     (prevents large sofa from being mistaken for a bed)
 *   - If TV detected AND bed confidence < 0.32 → bedroomScore = 0
 *     (prevents low-confidence bed from overriding a strong TV signal)
 *
 * Minimum score of 1.5 required to return a classification.
 * Tie-breaking: bedroom > dining_room > living_room
 *   (dining only wins if diningScore strictly exceeds livingScore)
 *
 * Model: YOLOv8n ONNX (~12 MB)
 *   Input  "images":  [1, 3, 640, 640] float32  (RGB, values 0..1, no ImageNet norm)
 *   Output "output0": [1, 84, 8400]    float32  (4 box coords + 80 COCO class scores)
 */

// ─── CDN + model ──────────────────────────────────────────────────────────────

const ONNX_RUNTIME_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js";
const ONNX_WASM_PATH   = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";

/** YOLOv11n ONNX hosted on Gennoctua GCS (~10 MB) */
export const DEFAULT_ROOM_MODEL_URL =
  "https://storage.googleapis.com/gennoctua/yolo11n.onnx";

// ─── Public types ─────────────────────────────────────────────────────────────

export type RoomType =
  | "bedroom"
  | "living_room"
  | "dining_room"
  | "kitchen"
  | "bathroom"
  | "other";

export type RoomClassification = {
  roomType: RoomType;
  /** Normalised confidence 0–1 (derived from YOLO score 0–4+) */
  confidence: number;
  /** Raw YOLO inference score (sum of object scores). Use for ranking candidates. */
  yoloScore: number;
  /** true when a known room type was detected above the minimum score threshold */
  isRoom: boolean;
  /** Highest-confidence detected object label (e.g. "bed", "couch") */
  label: string;
};

// ─── COCO-80 furniture class indices ─────────────────────────────────────────
// Same indices across YOLOv3 and YOLOv8 — they both use the standard COCO-80 set.

const FURNITURE_CLASS_MAP: Record<string, number> = {
  "chair":        56,
  "couch":        57,
  "bed":          59,
  "dining table": 60,
  "tv":           62,
};

// ─── Detection threshold ──────────────────────────────────────────────────────
// Bypass the model's built-in NMS (not present in YOLOv8n raw export) and scan
// raw class scores directly. 0.15 is empirically the minimum for real detections.

const RAW_SCORE_THRESHOLD = 0.15;

// ─── Per-class max distinct boxes ────────────────────────────────────────────
// Realistic upper bound on how many of each object appear in one room photo.
// Prevents duplicate boxes for the same object (e.g. same TV at multiple scales)
// from inflating the living-room score.

const MAX_BOXES_PER_CLASS: Record<string, number> = {
  "chair":        4,   // dining set / lounge chairs
  "couch":        2,   // L-shaped sectionals
  "bed":          2,   // twin beds
  "tv":           1,   // one TV per room
  "dining table": 1,   // one table per room
};

const CENTRE_MIN_DIST_PX = 80; // suppress near-duplicate boxes closer than this

// ─── RoomInference scoring ────────────────────────────────────────────────────

type Detection = { label: string; confidence: number; areaPercentage: number };

function inferRoom(
  detections: Detection[],
): { room: RoomType; score: number; topLabel: string } | null {
  let livingScore  = 0;
  let bedroomScore = 0;
  let diningScore  = 0;

  let bedConf   = 0;
  let bedArea   = 0;
  let couchConf = 0;
  let topLabel  = "";
  let topScore  = 0;

  // Pre-pass: check if a dining table is present — chairs behave differently
  const hasDiningTable = detections.some(d => d.label === "dining table");

  for (const d of detections) {
    if (d.confidence > topScore) { topScore = d.confidence; topLabel = d.label; }

    switch (d.label) {
      case "bed":
        // High-confidence bed gets a bonus point — prevents chair/couch combos
        // from outscoring a clearly visible bed.
        bedroomScore += d.confidence > 0.50 ? 3.0 : 2.0;
        if (d.confidence > bedConf) { bedConf = d.confidence; bedArea = d.areaPercentage; }
        break;

      case "couch":
        // Relaxed area check: even a partially visible couch is a living-room signal.
        livingScore += d.areaPercentage >= 0.08 ? 2.0 : 1.5;
        if (d.confidence > couchConf) couchConf = d.confidence;
        break;

      case "tv":
        livingScore += 1.5; // TV strongly implies living room
        break;

      case "chair":
        // Chairs around a dining table → dining; standalone chairs → living.
        if (hasDiningTable) diningScore += 0.5;
        else                livingScore += 0.8;
        break;

      case "dining table":
        // Lowered from 18% → 8%: real dining tables rarely fill 18% of frame.
        if      (d.areaPercentage >= 0.08) diningScore += 2.0;
        else if (d.areaPercentage >= 0.03) diningScore += 1.0;
        break;
    }
  }

  // ── Anti-false-positive rules ─────────────────────────────────────────────

  // 1. If couch confidence is within 5% of bed confidence, it's likely a sofa
  //    being misread as a bed → zero out bedroom score.
  if (bedroomScore > 0 && couchConf > bedConf * 0.95) {
    bedroomScore = 0;
  }

  // 2. If a TV is detected AND the bed confidence is very low (< 0.32), the
  //    "bed" is probably a chaise/sofa. A real bed in a room with a TV would
  //    score much higher than 32%.
  const hasTV = detections.some(d => d.label === "tv");
  if (bedroomScore > 0 && hasTV && bedConf < 0.32) {
    bedroomScore = 0;
  }

  void bedArea; // reserved for future area-based anti-FP rules

  const maxScore = Math.max(livingScore, bedroomScore, diningScore);
  if (maxScore < 1.5) return null;

  // Tie-breaking priority:
  // • bedroom first (bed is the most distinctive single object)
  // • dining only if it strictly exceeds living (living beats dining in ties —
  //   an open-plan space with couch + corner table is a living room)
  // • otherwise living_room
  let room: RoomType;
  if      (bedroomScore === maxScore) room = "bedroom";
  else if (diningScore  >  livingScore) room = "dining_room";
  else                                  room = "living_room";

  return { room, score: maxScore, topLabel };
}

// ─── Minimal ONNX Runtime type shims ─────────────────────────────────────────

type OrtTensor = {
  data: Float32Array | Int32Array | BigInt64Array;
  dims: number[];
  type: string;
};

type OrtSession = {
  inputNames:  string[];
  outputNames: string[];
  run: (feeds: Record<string, unknown>) => Promise<Record<string, OrtTensor>>;
};

type OrtRuntime = {
  env:              { wasm: { wasmPaths: string } };
  InferenceSession: { create: (url: string, opts: Record<string, unknown>) => Promise<OrtSession> };
  Tensor:           new (type: string, data: Float32Array, dims: number[]) => unknown;
};

// ─── Singleton ────────────────────────────────────────────────────────────────

let roomClassifierPromise: Promise<{ ort: OrtRuntime; session: OrtSession }> | null = null;

function loadOrtScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { ort?: unknown }).ort) { resolve(); return; }
    if (document.querySelector(`script[src="${ONNX_RUNTIME_CDN}"]`)) {
      const iv = setInterval(() => {
        if ((window as unknown as { ort?: unknown }).ort) { clearInterval(iv); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(iv); reject(new Error("ort load timeout")); }, 20_000);
      return;
    }
    const s = document.createElement("script");
    s.src = ONNX_RUNTIME_CDN;
    s.async = true;
    s.onload  = () => setTimeout(resolve, 100);
    s.onerror = () => reject(new Error(`Failed to load ONNX Runtime: ${ONNX_RUNTIME_CDN}`));
    document.head.appendChild(s);
  });
}

/**
 * Load ONNX Runtime Web + YOLOv8n model.
 * Singleton — loaded only once per page session.
 */
export function ensureRoomClassifierReady(
  modelUrl: string = DEFAULT_ROOM_MODEL_URL,
): Promise<{ ort: OrtRuntime; session: OrtSession }> {
  if (!roomClassifierPromise) {
    roomClassifierPromise = (async () => {
      await loadOrtScript();

      const ort = (window as unknown as { ort?: OrtRuntime }).ort;
      if (!ort) throw new Error("onnxruntime-web did not expose window.ort");

      ort.env.wasm.wasmPaths = ONNX_WASM_PATH;

      const session = await ort.InferenceSession.create(modelUrl, {
        executionProviders:     ["wasm"],
        graphOptimizationLevel: "all",
      });

      return { ort, session };
    })();
  }
  return roomClassifierPromise;
}

/** Reset singleton — forces reload on next call (e.g. to swap model URLs). */
export function resetRoomClassifier(): void {
  roomClassifierPromise = null;
}

// ─── Image preprocessing ──────────────────────────────────────────────────────

const YOLO_INPUT_SIZE = 640; // YOLOv8n native input size

/**
 * Resize to 640×640 and pack as [1, 3, 640, 640] float32 NCHW.
 * YOLOv8n expects values in [0, 1] — no ImageNet normalization.
 */
function preprocessForYolo(img: HTMLImageElement, ort: OrtRuntime): unknown {
  const S = YOLO_INPUT_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width  = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S); // RGBA, 8bpc

  const float32 = new Float32Array(3 * S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const pi = (y * S + x) * 4;
      const ch = y * S + x;
      float32[0 * S * S + ch] = data[pi]     / 255; // R
      float32[1 * S * S + ch] = data[pi + 1] / 255; // G
      float32[2 * S * S + ch] = data[pi + 2] / 255; // B
    }
  }

  return new ort.Tensor("float32", float32, [1, 3, S, S]);
}

// ─── Output parsing ───────────────────────────────────────────────────────────

/**
 * Parse YOLOv8n output tensor [1, 84, 8400].
 *
 * Layout per box b (0..8399):
 *   output[0 * 8400 + b] = cx   (center-x, pixels in [0, 640])
 *   output[1 * 8400 + b] = cy   (center-y)
 *   output[2 * 8400 + b] = w    (width)
 *   output[3 * 8400 + b] = h    (height)
 *   output[(4+c)*8400+b] = raw class score for COCO class c
 *
 * For each furniture class, collect top-N spatially-distinct boxes
 * (centres must be ≥ CENTRE_MIN_DIST_PX apart to suppress duplicates).
 * This lets multiple chairs each contribute to the room score.
 */
function parseOutputs(
  outputs: Record<string, OrtTensor>,
  outputNames: string[],
): Detection[] {
  const S   = YOLO_INPUT_SIZE; // 640
  const out = outputs[outputNames[0]];

  if (!out || out.type !== "float32" || out.dims[2] !== 8400) return [];

  const N    = 8400;
  const data = out.data as Float32Array;
  const dets: Detection[] = [];

  for (const [label, classIdx] of Object.entries(FURNITURE_CLASS_MAP)) {
    const row     = (4 + classIdx) * N;
    const maxCount = MAX_BOXES_PER_CLASS[label] ?? 1;

    // Collect all boxes above threshold for this class, sorted best-first
    const candidates: Array<{ idx: number; score: number }> = [];
    for (let b = 0; b < N; b++) {
      const s = data[row + b];
      if (s > RAW_SCORE_THRESHOLD) candidates.push({ idx: b, score: s });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);

    // Greedy spatial deduplication — accept up to maxCount non-overlapping boxes
    const accepted: Array<{ cx: number; cy: number; score: number; area: number }> = [];

    for (const { idx, score } of candidates) {
      if (accepted.length >= maxCount) break;
      const cx = data[0 * N + idx];
      const cy = data[1 * N + idx];

      const tooClose = accepted.some(a => {
        const dx = cx - a.cx, dy = cy - a.cy;
        return Math.sqrt(dx * dx + dy * dy) < CENTRE_MIN_DIST_PX;
      });
      if (tooClose) continue;

      const w  = data[2 * N + idx];
      const h  = data[3 * N + idx];
      accepted.push({ cx, cy, score, area: (w * h) / (S * S) });
    }

    for (const { score, area } of accepted) {
      dets.push({ label, confidence: score, areaPercentage: area });
    }
  }

  return dets.sort((a, b) => b.confidence - a.confidence);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify a room image using YOLOv8n object detection + RoomInference scoring.
 *
 * Returns `{ roomType: "other", isRoom: false, yoloScore: 0 }` on any error
 * or when no furniture is detected above threshold.
 * ONNX Runtime + model are loaded lazily on the first call (singleton).
 */
export async function classifyRoom(
  file: File,
  modelUrl?: string,
): Promise<RoomClassification> {
  try {
    const { ort, session } = await ensureRoomClassifierReady(modelUrl);

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el  = new Image();
      const url = URL.createObjectURL(file);
      el.onload  = () => { URL.revokeObjectURL(url); resolve(el); };
      el.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
      el.src = url;
    });

    const imageTensor = preprocessForYolo(img, ort);

    // YOLOv8n has a single input named "images" (no separate shape tensor)
    const feeds: Record<string, unknown> = {
      [session.inputNames[0]]: imageTensor,
    };

    const output     = await session.run(feeds);
    const detections = parseOutputs(output, session.outputNames);
    const result     = inferRoom(detections);

    if (!result) {
      return {
        roomType:   "other",
        confidence: 0,
        yoloScore:  0,
        isRoom:     false,
        label:      detections[0]?.label ?? "none",
      };
    }

    return {
      roomType:   result.room,
      // Normalise raw score (typical range 1.5–6) to 0–1
      confidence: Math.min(1, result.score / 6),
      yoloScore:  result.score,
      isRoom:     true,
      label:      result.topLabel,
    };

  } catch {
    return { roomType: "other", confidence: 0, yoloScore: 0, isRoom: false, label: "error" };
  }
}
