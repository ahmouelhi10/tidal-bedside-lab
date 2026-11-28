# Intended use and limitations

**Intended use.** Supervised education of residents, medical students and nurses in emergency and anaesthesia care: recognising and managing cardiac arrest and ACS, airway and induction planning across body habitus, haemorrhagic shock, opioid overdose. Learners practise decisions and sequencing and see physiological consequences in real time.

**Not intended for.** Clinical decision support, dose calculation for real patients, device validation, certification or high-stakes licensing decisions, or any use on real patient data. The software is an *education tool, not a validated medical device*.

## Known limitations (read before relying on outputs)

1. Several constants are **design values** chosen for plausibility or calibrated to published *targets* rather than fitted to patient data (see VALIDATION.md). The simulator is therefore qualitatively faithful and quantitatively approximate.
2. The ROSC model is a *calibrated hazard model*, not a mechanistic one; outcomes are probabilistic and tuned to published registry ranges (CARES, GWTG).
3. Drug models other than propofol/remifentanil are simplified one-compartment or phenomenological models; adult patients only (age 18-100); no paediatrics, pregnancy, renal/hepatic failure or chronic disease modifiers beyond the scenario-specific ones.
4. The 3D patient is procedural (no clothing, hair styles or anatomy detail); it conveys habitus, colour, breathing and compressions, not anatomical realism.
5. Scores are derived from guideline recommendations current at the time of authoring (AHA 2025) and must be re-checked when guidelines change.
6. Server verification checks that the replayed log reproduces the submitted hash and carries exactly the instructor changes the server delivered. The score always comes from the server's own replay. Verification does not authenticate learners or prove a log was played by hand (the engine is public, so an edited log can be given a matching hash). Add SSO/reverse-proxy authentication for exams.
7. Replay hashes are quantised to 6 decimals to tolerate last-bit differences between JavaScript engines; a mismatch is reported as *unverified*, not rejected.

## Data protection

No real patient data is processed. The only personal field is the optional *learner ID*; use a pseudonym. Session logs (events, scores) are stored as JSON under `DATA_DIR`. Define a retention period and back-up policy with your data-protection officer.

## Clinical governance

Before use in a curriculum, have an anaesthetist/emergency physician review the scenario criteria and the UNVERIFIED parameter list, record the review and sign-off, and re-review after each engine release (`BUILD.json` carries a content hash of the engine).
