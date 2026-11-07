# Validation status

How the simulator is checked, what is verified, and - above all - what is **not**. Nothing here substitutes for review by a practising anaesthetist or emergency physician.

## 1. Automated verification (208 tests, `npm test`)

| Area | What is asserted | Source of the expected value |
|---|---|---|
| Anthropometrics | BMI classes, IBW, PBW, LBM (James/Janmahasatian/Hume), TBW (Watson), blood volume (Nadler/Lemmens), BSA, REE | Published formulas and worked examples |
| PK engine | Exact matrix-exponential solution vs. analytic bi-/tri-exponential, mass balance, effect-site equilibration | Mathematics; published rate constants |
| Propofol / remifentanil | Eleveld, Marsh, Schnider, Minto parameter sets and covariate scaling | OpenTCI/TIVA reference tables (see REFERENCES) |
| Circulation | Starling/venous-return behaviour, baroreflex sigmoid, haemorrhage classes, fluid response | Pulse engine methodology, ATLS bands (qualitative) |
| Respiratory | SaO2-PaO2 curve, alveolar gas equation, apnoea desaturation vs. BMI, pre-oxygenation benefit | Severinghaus, Farmery/Roe, published apnoea-time ranges (widened bands, see section 3) |
| CPR / ACLS | Rate/depth/CCF effects, CPP threshold, ROSC rates for shockable/non-shockable, epinephrine effect, no-benefit drugs | AHA 2025, Paradis 1990, Reynolds 2012, CARES (calibration targets) |
| Scenarios | Scripted expert runs score >= 80 %, idle runs <= 40 % (gap >= 40 points), every scenario reachable and finite | Scenario criteria (guideline-derived) |
| Tube and bronchoscopy | Optimal depth 4 cm above the carina at any height; a tube past the carina raises shunt and lowers SpO2 until pulled back; chosen depth honoured; secretions negligible for 20 min and obstructive after 60, cleared by suction; scope raises PaCO2 a little; malformed events rejected; replay-identical; the scope can be steered into every lobe | Design values (section 2) |
| Procedure démarche | Not applicable until the procedure is done; experts follow every step; rushed RSI (laryngoscopy before full paralysis), charging without CPR and undocumented decompression lose most of it; pre-oxygenation credit grows to 3 min; declared steps have a small share and skipped ones none; replay-identical | Guideline step sequences (design weights) |
| Determinism | Same spec+seed+events => identical hash; replay of a recorded log reproduces the hash; tampering detected | Engineering invariant |
| Robustness | Seeded fuzz of 40 random interventions never yields NaN/Infinity; malformed events rejected; BMI 15-65 x both sexes stable | Engineering invariant |
| Surgical gestures | Needle decompression vs. chest-wall thickness (5 cm catheter failure ~38/31/13 % at the three sites; failure falls with length), tension physiology (venous return, shunt, ventilation, CPR flow), catheter blocking and recurrence, chest drain (rate, malposition, wrong side), cricothyroid palpation vs. BMI, scalpel-bougie vs. cannula success/duration, barotrauma, separate random stream leaves existing runs unchanged, tension and CICO scenarios (expert >= 80 %, idle <= 40 %) | Ahmad 2025, Laan 2016 (secondary), Umek 2020, Rees 2019, Lavelle 2021; physiological effects are design values |
| Server | MIME/traversal, validation, limits, end-to-end seed->play->replay->score, tampering, abuse, persistence, auth | Engineering invariant |

Browser checks performed manually in headless Chrome (SwiftShader WebGL2): application boots without console errors, scenarios start, monitor/3D/trends render, intervention panels dispatch events, a STEMI session was played to the debrief and the server reported *verified by replay*, EN/FR switch works, obese/thin/tall bodies render. There is **no automated browser test suite** yet.

## 2. UNVERIFIED design parameters (registry status `UNVERIFIED`/`design`)

These are chosen for plausibility or calibrated to a target; none is fitted to patient data. Review each before relying on it clinically.

- Vasopressor PD (norepinephrine, phenylephrine, epinephrine receptor C50s, HR add-ons) and single-compartment kinetics of atropine, nitroglycerin, adenosine, naloxone.
- Propofol haemodynamic coefficients (SVR -42 %, inotropy -25 %, venous tone -30 %, baroreflex blunting at high Ce) - calibrated to typical induction MAP falls.
- Arrest/ROSC model: readiness time constants (90 s up / 240 s down), CPP smoothing (12 s), VF amplitude fade (~8 min), spontaneous-ROSC hazards for PEA/asystole (0.03/0.07 and 0.008/0.02 per min with/without a treated cause), CPR surface loss (20 %), defibrillator charge time and impedance-BMI relation.
- Hypoxic myocardial depression (`myoHypox`) and the hypoxic-arrest trigger; massive-opioid abolition of the hypoxic drive (factor 0.95); naloxone effective at >= 0.2 mg (event-level rule).
- Respiratory: lung volumes (back-fit to Jense 1991 / Farmery-Roe), dead-space and CO2 store sizes, atelectasis shape, age-related shunt, critical DO2, VO2/VCO2 reduction under anaesthesia (-18 %).
- Fluids/thermal: capillary refill kinetics, venous haematocrit defaults (0.40 F / 0.45 M), non-shivering thermogenesis.
- Surgical gestures (all design values, none fitted to patient data): needle margin beyond chest-wall thickness (3 mm), thickness slopes with BMI (1.8/1.7/1.6 mm per unit) and the residual spread (SD 6 + 3.5 mm); tension physiology (airway pressure 14 mmHg at full tension, intrathoracic pressure 1.5x right / 1.0x left, pump depression 45 %, contralateral shunt 0.3, ventilation loss 35 %, CPR flow loss 65 %); the 3x leak enhancement under positive pressure; catheter patency (~7 min mean, shorter with obesity) and the 600 s leak-sealing time constant after a drain; drain rate and malposition (5 % + 10 % x obesity); drain insertion time (2-3 min); front-of-neck success and duration modifiers for obesity, impalpable landmarks and cannula depth; cannula displacement and barotrauma hazards; the cardiac-injury risk flag for long left-lateral catheters (flag only, no physiological consequence is modelled).
- Scoring: weights and time thresholds of every criterion are educational choices, not outcome-validated.
- Tracheal tube and bronchoscopy (`src/engine/ett.js`, all design values): optimal depth 0.1 x height + 4 cm at the incisors with the carina 4 cm beyond; endobronchial (right main bronchus) beyond 0.5 cm past the carina, one-lung shunt 0.28 and alveolar ventilation x 0.92; cuff at the cords above 7 cm (ventilation x 0.85); secretions rising 1/h, obstructive above 0.5 (shunt up to 0.12 per lung, tracheal ventilation loss up to 25 %); scope in the tube ventilation x 0.85; each suction pass de-recruits 0.04 of shunt (time constant 60 s). The airway tree drawn by the bronchoscope (`src/web/gl/airway.js`) uses approximate textbook adult dimensions scaled with height and sex; it is visual only.
- Procedure démarche criteria (`src/engine/demarche.js`, weight 8 per scenario): the step lists follow the cited sequences (Weingart 2012 / DAS 2015 for RSI, AHA 2025 for defibrillation, ATLS for decompression and drains, DAS 2015 for front-of-neck access), but the per-step weights, the 3-min pre-oxygenation and 45-s relaxant ramps, the 10-s CPR-resumption window and the 2-min reassessment window are design values. The `tube_desat` scenario criteria (FiO2 1.0 within 60 s, bronchoscopy within 4 min, tube back in the trachea within 5 min, final tip 2-6 cm above the carina, right-sided suction) and the bronchoscopy démarche (FiO2 before the scope, tube moved only while looking, scope out within 3 min) are design values built on the DOPE mnemonic. Safety steps without a physical trace (check-list, skin antisepsis, "stand clear") are only *declared* by the learner from the guided panel and carry a small share (0.5 of 7-9.5 weight units).

## 3. Known deviations from literature (deliberate)

- Pre-oxygenation / apnoea test bands were **widened**: SpO2 90 -> 60 % interval 20-70 s; pre-oxygenated (FeO2 ~0.9) vs. 80 % difference ~104 s; propofol HR change +9 %. Reason: published ranges are wide and population-dependent.
- Eleveld V1/Q2 normalisation has two published variants; the engine uses one and documents the choice in `drugs.js`; the other is *unresolved*.
- ATLS haemorrhage bands (AT-BR-1) replaced a primary reference that could not be retrieved; they are used qualitatively only.
- Deliberately **not** used: Absalom's Schnider 77 mg example (unresolved discrepancy), PyTCI `effect_bolus`, Marsh time-to-peak-effect targets.
- Watson male age coefficient fixed to -0.09516 (verified against the original).
- Rocuronium onset ~100 s at 0.74 mg/kg TBW (inside published 60-120 s ranges).
- State hash quantised to 6 decimals; cross-engine (V8 vs. SpiderMonkey/JSC) equality is expected but not tested.

- Surgical gestures: the tension pneumothorax is unilateral and simple (no haemothorax, no bilateral injury, no mediastinal shift beyond the examination sign); lung sliding and thickness readings are deterministic with a fixed small error; the chest rise asymmetry is reported in the examination text and not drawn on the 3D mesh; the cannula/jet-ventilation path uses a single efficiency of 0.5; attribution of Laan 2016 and the DAS/NAP4 figures rests on secondary sources.

## 4. Not yet done

Clinician sign-off (the review pack is [CLINICAL_REVIEW.md](CLINICAL_REVIEW.md); no item has been signed off); comparison against Pulse/BioGears on shared test cases; usability study with residents; load test of the replay pool; accessibility audit (keyboard and screen-reader basics are in place, contrast is not audited); automated end-to-end browser tests; a first green run of the CI workflow and of the Docker image build (both are written and their non-Docker steps were run locally, but neither has run on a Docker host).
