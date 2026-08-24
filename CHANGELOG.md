# Changelog

## [0.3.2] — 2026-08-24

### Added
- **`sdk.selection.override(category, blob, hash?)`** — pin the exact photo `personalize()`/`personalizeAll()` uses for a category, bypassing the SDK's own independent `selectedAssets` pick. For integrations that separately resolve identity across body sizing, face sizing, and VTO (e.g. a face-cluster-frequency ranking when a gender bucket contains more than one real person) — without this, VTO could render onto a different person than body/face measurement used, even though both sit under the same gender profile.

---

## [0.3.1] — 2026-08-14

### Fixed
- **Side detection** — detect a profile by edge-on shoulder ratio (shoulder-width / torso-height &lt; 0.45), not the front-facing label. A real side scores in the "angled" band, so the label missed it and `sideRank` never fired.

---

## [0.3.0] — 2026-08-14

### Added
- **SDK-side front + side pairing:** `sdk.measurement.getBodyPair(gender)` and exported `selectBodyPair(scanIndex, gender)` → best front + side for the `measure_fs` sizing method (no `/api/select` round-trip, no second ML pass)
- Per-photo **`armsAway`** (arm abduction ≥ 5°) and **`sideRank`** (side + full-body standing) on every `scanIndex` entry
- `BodyPairResult` type: `{ front, side, frontOk, sideOk, reasons, candidates, action }`

### Unchanged
- Profile selection, VTO, v0.2 measurement shortlists — same API surface

---

## [0.2.1] — 2026-08-10

### Fixed
- Load **`faceRecognitionNet`** before `.withFaceDescriptors()` during ingest — fixes `FaceRecognitionNet - load model before inference` on v0.2.0

---

## [0.2.0] — 2026-08-07

### Added
- **Measurement handoff (P2 prep):** `sdk.measurement.getScanIndex()`, `cluster()`, `getPhotoShortlists()`, `prepare()`
- **`scanIndex`** persisted during `ingestImages()` — face + pose scores for every solo person photo (no second ML pass)
- Face **descriptors** during ingest for identity clustering
- `SelectionSummary.scanIndexCount` field

### Unchanged (existing prod sites on `@9687b9e` / v0.1.x)
- Profile selection, VTO, room classification, LLM refinement — same API surface

### Not in this release (planned v0.3+)
- Automatic **front + side** pairing for `measure_fs` body sizing API
- Server-side sizing POST from SDK

---

## [0.1.0] — prior

- Initial web SDK: ingest, profile selection, HyperPersona VTO, room photos
