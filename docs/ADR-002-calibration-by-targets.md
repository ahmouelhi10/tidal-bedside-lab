# ADR-002: Calibrate hard-to-source dynamics to published targets, and say so

**Status:** Accepted  **Date:** 2026-11-06  **Deciders:** Engineering lead, clinical advisor (to be named)

## Context
Several dynamics a resuscitation simulator needs (ROSC probability under CPR, pressor dose-response in shock, hypoxic cardiac arrest, propofol haemodynamics) have no single published parametric model that can be implemented and cited. Silently inventing constants would look rigorous and be misleading.

## Decision
1. Where a mechanistic published model exists (PK of propofol/remifentanil, Severinghaus saturation, Hahn fluid kinetics, Nadler/Lemmens blood volume) implement it as published and test against the published values.
2. Where only outcome *targets* exist (AHA 2025 quality thresholds, CARES/GWTG ROSC ranges, ATLS haemorrhage bands, apnoea-time ranges), implement a transparent shape (hazard, sigmoid, first-order lag) and **calibrate it so tests hit the targets**, with the constant tagged `REF design`.
3. Every such constant is listed in `docs/VALIDATION.md` and carries registry status `UNVERIFIED`; tests assert the *target band*, never a value copied from the code.
4. Bands that the literature gives as wide ranges are asserted wide (see VALIDATION section 3) rather than narrowed to make a test pass.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A. Calibrate to targets and disclose (chosen) | Honest, testable, reviewable, deployable now | Quantitatively approximate; needs clinician review |
| B. Embed a full-body engine (Pulse/BioGears) | Higher mechanistic fidelity | C++/WASM toolchain and licensing, large, hard to audit; not possible offline here |
| C. Hard-code scripted outcomes | Simple | Not interactive; teaches nothing about causes |

## Consequences
Easier: explaining every number to reviewers; changing a constant with a failing test pointing at the clinical target. Harder: claims of validation - none are made. To revisit: cross-validation against Pulse/BioGears and, ideally, clinician-graded expert runs.
