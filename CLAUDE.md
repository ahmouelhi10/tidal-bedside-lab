# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Tidal Bedside Lab: a 3D emergency-room / anaesthesia physiology simulator for medical training. Plain JavaScript ES modules, **zero runtime and zero dev dependencies** (Node >= 20, no `npm install`, no bundler). Keep it that way: do not add packages (see `docs/ADR-001-architecture.md`).

## Commands

```bash
npm start                      # node src/server/server.js -> http://localhost:8080
npm test                       # node scripts/test.js: runs every tests/*.test.js (~2 min; works on Node 20, which does not expand globs)
node --test tests/pk.test.js   # one test file
node --test --test-name-pattern="catalogue" tests/scenarios.test.js   # one test by name
npm run check                  # node --check on every .js under src/, scripts/, tests/
npm run verify                 # check + test (what CI runs on Node 20 and 22)
npm run build                  # syntax check, then copy src/docs into dist/ + dist/BUILD.json (engine sha256)
npm run docs                   # regenerate docs/REFERENCES.md from src/engine/references.js
```

CI also fails if `docs/REFERENCES.md` is stale, so run `npm run docs` after editing `references.js`. `dist/` is a build output (gitignored).

Server env vars: `PORT`, `HOST`, `DATA_DIR` (session JSON store, default `./data`), `WEB_DIR`, `API_TOKEN` (enables instructor endpoints), `TRUST_PROXY=1`, `LOG_LEVEL=debug`.

## Architecture

Three layers share one engine:

- **`src/engine/`**: pure physiology, no DOM or Node APIs, so it runs unchanged in the browser, under `node --test`, and in the server's replay worker. `patient.js` (`Patient`) composes the modules (`cardio`, `respiratory`, `pk`/`drugs`, `fluids`, `thermal`, `cpr`, `rhythm`, `surgical`, `anthropometrics`) and integrates them on a fixed `DT = 0.1 s` step.
- **`src/server/server.js`**: `node:http` server with no framework. `live.js` relays the live instructor channel (Server-Sent Events: learner state out, `instructor.inject` changes in); `research.js` builds the de-identified research export (`GET /api/research/export`, see `docs/VALIDITY_STUDY.md`). It serves `src/web/` at `/` and **`src/engine/` at `/engine/`**, which is how the browser imports the engine (`import ... from '/engine/patient.js'`). It also exposes the scenario/session API (`docs/API.md`) and stores sessions as JSON files with atomic writes. `replay-worker.js` re-runs submitted sessions in worker threads.
- **`src/web/`**: client. `sim.js` owns the `Patient`, the clock and fast-forward, and the event log. `gl/` is a hand-written WebGL2 renderer that builds the patient procedurally from body numbers. `monitor.js` is the Canvas2D monitor, `ui.js`/`gestures.js` handle the DOM UI and hand animations, and `i18n.js` holds EN/FR strings. `procedures.js` defines the guided step-by-step procedures (the "Guided" dock tab). Each step dispatches ordinary engine events plus a `note` event, so guided runs still replay and verify. The patient is `assets/patient.glb` (MakeHuman/MPFB, CC0, built by `assets-src/build_patient.py`; conventions in `assets-src/README.md`), read by `gl/gltf.js`, morphed per patient by `gl/patient-glb.js`, and picked by `gl/pick.js`. The procedural body in `gl/anatomy.js` is the fallback while it loads or if it fails (ADR-003). `handson.js` (instrument tray and drag gestures) and the pure `handson-eval.js` drive the guided steps that have a `hand` spec in `procedures.js`. The drop point picks the side and site of the ordinary engine events. `bronchoscope.js` is the bronchoscopy window. It has its own small WebGL2 renderer, and `gl/airway.js` provides the airway tree, the mesh and scope navigation. Steering is visual only; insert, suction, remove and tube depth are engine events (`src/engine/ett.js` models tube depth and secretions). The camera is driven only by the game (no user orbit): `Scene.setCamera`/`focus` tween to an action's site and back to the `default` overview, and `frameStepSite` frames the next guided step's site along its skin normal ahead of time (`ui.prefocusStep`). The start screen has three sections (physiology lab, skills training, resuscitation and challenges). Skills training starts the case listed in `SKILL_CASE` (`ui.js`) and opens that procedure's workspace, an instrument table you drag from onto the patient. The renderer and UI only read engine state. They never change physiology directly.

### Determinism / replay contract (do not break)

State at time t is a pure function of `(patientSpec, seed, scenario, ordered event log)`. Rules that follow from this:
- No `Math.random`, no wall-clock in the engine. Use `Rng` (`rng.js`). Surgical gestures use a separate stream (`rngS`) so they don't shift the main random sequence.
- Every intervention goes through `Patient.dispatch({type, ...})`, which logs it with `t`. The allowed types are `EVENT_TYPES` in `patient.js`. The server rejects unknown types, so a new intervention must be added there, validated in `validateEventShape`/`NUMERIC_EVENT_PARAMS`, and handled in `_apply`. Invalid events are still logged and rejected the same way during replay.
- The server issues the seed. On submit it replays the log (`replay()` in `patient.js`) and compares `Patient.stateHash()`, an FNV-1a hash of a quantised state vector. New state that affects the trajectory should be added to `stateHash()`.
- `Patient` warms up for 30 s (+ `scenario.preRunS`) in its constructor, then resets `n` to 0.

### Evidence / reference rules

- Every engine model constant carries a `REF <id>` comment (or `ref: '<id>'` property) whose id exists in `src/engine/references.js`. `tests/references.test.js` enforces this.
- Per `docs/ADR-002-calibration-by-targets.md`: constants with no published source are tagged `REF design`, calibrated so tests land in published target bands, listed in `docs/VALIDATION.md`, and marked `UNVERIFIED`. Tests assert the clinical target band, never a value copied from the code. Don't narrow a band just to make a test pass.

### Debrief, team mode, clotting

`src/engine/debrief.js` finds the moments worth discussing on the replayed timeline and compares the self-assessment with the score; `src/web/debrief-ui.js` runs the pre-brief, the self-assessment and the four PEARLS phases. `src/engine/team.js` is team mode: `team.order` returns a read-back that is sometimes wrong (own random stream `rngT`), the client carries out what `team.confirm` returns, and the `closed_loop` criterion is added to every scored case once team mode is used. `src/engine/coag.js` turns the clotting amounts carried by `Volumes` into INR, fibrinogen, platelets and an in-vivo clotting function that adds oozing; the laboratory INR deliberately ignores cold and acidosis. Electrolytes drive the monitor's ECG shape (`Electrolytes.ecg()`) and the hyperkalaemic arrest hazard.

### Scenarios

Scenarios are data in `src/engine/scenarios.js`. Each has a `spec`, `init(patient)`, a scripted `timeline`, and a `score` function built from `criteria` (each with `REF` ids). `scoreSession` scores a finished `Patient`. The browser loads `scenarios.js` too (the coach and the local score use the criteria), so a curious learner can read them; the score that counts is the server's, recomputed from its own replay on submit. `criteria.demarche(id)` (`src/engine/demarche.js`) scores whether a procedure was done in order (preparation, the act, confirmation). It is not applicable until the procedure happens. It is scored from real events. Safety steps that leave no trace count only through `note` events "guide <proc>: <step>" from the guided panel, so the note text format is part of the scoring contract. `tests/scenarios.test.js` pins the exact set of scenario ids. Test helpers in `tests/helpers/` (`bots.js`: `mk`, `scen`, `runScript`, `aclsTeam`; `experts.js`: `expertRun`, `idleRun`) drive patients with scripted learners.

### Body envelope

Valid input: age 18-100, height 140-210 cm, weight 35-250 kg, BMI 15-65 (`LIMITS` in `server.js`). The server rejects anything outside this tested range.

## Constraints

This is an education tool, not a validated medical device. Physiological constants needing clinician review are tracked in `docs/VALIDATION.md` and `docs/CLINICAL_REVIEW.md`. The Content-Security-Policy is strict (`script-src 'self'`): no inline scripts and no CDN loads in `src/web/`.
