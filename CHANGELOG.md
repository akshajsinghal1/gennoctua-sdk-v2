# Changelog

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
