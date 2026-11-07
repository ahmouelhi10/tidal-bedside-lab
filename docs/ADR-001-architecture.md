# ADR-001: Zero-dependency deterministic physiology engine, WebGL2 client, Node server

**Status:** Accepted
**Date:** 2026-11-06
**Deciders:** Product owner (Tidal Bedside Lab), clinical advisor (to be named), engineering lead

## Context

Tidal Bedside Lab is a 3D emergency-room simulator for residents and young doctors. It must
reproduce believable physiology across body habitus (underweight to super-obese, both sexes,
ages 18-100), anesthetic and resuscitation pharmacology, airway and oxygenation, CPR/ACLS and
chest-pain/ACS scenarios, and give instant feedback to the learner. It will be hosted by clinics
and medical universities, often on locked-down intranets, so deployment must be simple and the
application auditable. The build environment for this repository has no package-registry access,
which also argues for a dependency-free design.

Forces: (1) credibility - every model and constant must trace to a citation; (2) testability -
physiology must be unit-testable against published numbers; (3) reproducibility - an exam
attempt must be replayable; (4) low latency - interventions must feel immediate; (5) easy
deployment - one container or any static host; (6) privacy - no real patient data.

## Decision

1. **Engine**: a pure JavaScript (ES modules) engine with no DOM or Node APIs, fixed time step
   (0.1 s), seeded random numbers, linear pharmacokinetics solved exactly with a matrix
   exponential, and explicit state objects. It runs unchanged in the browser, in Node tests and on
   the server.
2. **Client**: a hand-written WebGL2 renderer plus Canvas2D monitor and charts. The 3D patient is
   built procedurally from sex, age, height and weight (loft meshes), so every body type is
   supported without external assets.
3. **Server**: a small Node `http` server (no framework) that serves the client, exposes scenario
   and session APIs, stores session logs as JSON, and can **replay** a logged session with the same
   engine and seed to verify scores.
4. **Truth model**: the engine is the single source of truth for physiology; the renderer and
   monitor only read state. Interventions are events `{t, type, args}` appended to a log.
5. **References**: every model constant carries a reference id from `src/engine/references.js`;
   a test fails if a model cites an unknown id.

## Options Considered

### Option A: Unity (C#, PhysX) client with a separate physiology service
| Dimension | Assessment |
|-----------|------------|
| Complexity | High (two runtimes, build pipeline, WebGL export size) |
| Cost | Editor licences, CI machines |
| Scalability | Good for rich visuals |
| Team familiarity | Unknown |

**Pros:** mature 3D tooling, physics, animation. **Cons:** heavy WebGL builds, hard to run
physiology tests headless in the same runtime, hospital IT often blocks large downloads.

### Option B: Three.js or Babylon.js client plus JavaScript engine
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Free |
| Scalability | Good |
| Team familiarity | High |

**Pros:** rich ecosystem, GLB import. **Cons:** a dependency that cannot be fetched in this
build environment; supply-chain review overhead for hospital customers.

### Option C (chosen): Dependency-free engine, WebGL2 renderer, Node server
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium (we own a small renderer) |
| Cost | Free |
| Scalability | Static hosting scales trivially; server only stores logs |
| Team familiarity | High (plain JS) |

**Pros:** zero supply-chain surface, runs offline, identical code for tests/server/browser,
deterministic replay. **Cons:** we maintain the renderer; no skeletal animation or GLB import
yet (planned as an adapter).

## Trade-off Analysis

The decisive factors are testability and deployability. A physiology simulator is only as
credible as its tests, and Option C lets the same engine run under `node --test` with published
reference values as oracles. The renderer is a thin read-only view, so owning it is a bounded
cost; Option B can be adopted later by replacing `src/web/gl/` without touching the engine.

## Consequences

- Easier: audits, offline deployment, deterministic grading, CI.
- Harder: advanced visuals (skinning, PBR, import of scanned anatomy).
- Revisit: GLB/Blender asset import, skeletal animation, multi-user instructor mode (WebSocket),
  server-side accounts (LTI/SSO) once a host institution is chosen.

## Action Items

1. [x] Engine modules with reference registry and unit tests
2. [x] Procedural WebGL2 patient, monitor, intervention UI
3. [x] Node server with session store and replay verification
4. [ ] Clinical advisor review of every parameter marked SECONDARY or UNVERIFIED
5. [ ] External validation against Pulse/BioGears and PhysioNet/VitalDB distributions
6. [ ] Accessibility audit and French translation review
