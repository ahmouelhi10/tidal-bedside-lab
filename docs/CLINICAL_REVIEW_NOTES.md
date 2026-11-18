# Clinical review - notes for reviewers

Status: **input for the reviewers, not a sign-off.** Written with AI assistance on 2026-11-16. The sign-off table in section 4 of CLINICAL_REVIEW.md is untouched and the dossier stays open until a named clinician completes it. The engine code was not read.

## Guideline points checked on the web (2026-11-16)

- **Item 21:** ERC 2025 and AHA 2025 differ on when the first adrenaline is given in shockable rhythms, so an ERC profile is needed or the scoring must say it is AHA-only.
- **Item 27:** the `das2015` reference is superseded by the DAS 2025 guidelines (Br J Anaesth 2026;136:283-307). Re-read the `cico` scenario against them.
- **INF-1 / INF-2:** EUCAST breakpoints v16.1 are current until 31 December 2026, and the dosage table is a separate v16.0 document. Record the table version next to the engine hash.

## Arithmetic on the dossier's own formulas

- **Item 12:** the Nadler-to-Lemmens blend gives women a step of about 9-10 % in blood volume across BMI 28-32, while men stay within 1 %. Lemmens' rule has no sex term; Nadler's has.
- **Item 9:** "1 g of calcium chloride" means different amounts of calcium depending on the salt form, so the engine should compute in mmol of elemental calcium.
- **Item 23:** the untreated-PEA hazard of 0.03 per minute compounds to about 45 % return of circulation at 20 minutes, before readiness scaling.

## Engineering follow-up (2026-11-16)

Two of the points above were engineering problems and have been changed in the code. The clinical values are still for the reviewers.

- **Item 12 (done):** the blend is now a smooth hand-over from Nadler (BMI 27) to Lemmens (BMI 45), `bloodVolumeBlend` in `src/engine/anthropometrics.js`. Blood volume per kg no longer rises with weight and the slope has no kinks (unit test in `tests/anthropometrics.test.js`). Values moved by up to 8 % (women around BMI 32). Still open: the window, and whether the obesity rule should stay sex-neutral.
- **Item 9 (done):** calcium is carried as mmol of elemental calcium in the engine, the event log and the UI for both salts. The strengths and default doses are set in one place, `CALCIUM` in `src/engine/drugs.js`, and keep the earlier behaviour (chloride 0.68 mmol/mL, 6.8 mmol; gluconate 0.22 mmol/mL, 6.6 mmol). A bolus above 30 mmol is rejected as a unit error. Still open: which strength and default dose to use.
- **Items 21, 23, 27, INF-1 / INF-2:** not changed.

## Not covered

All other items (drug models, doses, timings, physiological targets, scenarios) are left for the clinical reviewers. No values are proposed here.
