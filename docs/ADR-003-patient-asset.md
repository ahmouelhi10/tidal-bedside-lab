# ADR-003: Realistic patient and instruments as glTF assets, procedural body as fallback

**Status:** Accepted
**Date:** 2026-11-07
**Deciders:** Product owner, engineering lead

## Context

The procedural patient (`src/web/gl/anatomy.js`) supports any body size, but learners found it too basic to look at.
They also wanted to perform procedures with instruments on the body rather than by pressing buttons. The application
must stay dependency-free (ADR-001), run offline, keep a strict CSP, and keep its deterministic replay.

## Decision

1. **One realistic supine patient** is built in Blender from MakeHuman data through MPFB (`assets-src/build_patient.py`) and exported as
   `src/web/assets/patient.glb` with `patient.json` (conventions in `assets-src/README.md`). Seven morph targets
   (female, heavy, thin, old and three female correctives) let one mesh follow every patient. Sex, age and BMI map to
   morph weights through a calibration table (`gl/patient-glb.js`), and height is a uniform scale.
2. **Instruments** (`assets/instruments.glb`) use the same pipeline: the origin is the working point and +Y the long axis.
3. **Loading** uses a minimal GLB reader written for this project (`gl/gltf.js`): no glTF library. The engine never sees the
   asset. The meshes are visual only, and landmarks are read from anchor vertices after morphing.
4. **Fallback:** until the asset is loaded, or if it fails, the procedural body is used. Every landmark name is shared, so
   the scene, gestures and tests behave the same with either body.
5. **Hands-on gestures** (`handson.js`, `handson-eval.js`) only choose the parameters of existing engine events: the side
   and site from the drop point, and the neck approach from the incision direction. Accuracy goes into the `note` event, so
   replay and scoring are unchanged.
6. **Licence:** the MakeHuman assets and everything derived from them are CC0 (`assets-src/LICENSE-ASSETS.md`).

## Consequences

- Easier: a believable patient for every body habitus, real drop-on-skin interaction, and assets that are reproducible from scripts.
- Harder: the bundle grows by about 6 MB, rebuilding needs Blender 4.2 and MPFB, and the morph calibration must be
  redone if the base mesh changes. A size test guards the budget.
- Not changed: physiology, scoring and replay. The visual body is not clinical data (`docs/VALIDATION.md`).
