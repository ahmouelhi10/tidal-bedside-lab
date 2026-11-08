# Clinical review dossier

Status: **open - no item below has been signed off.** Until the sign-off table in section 4 is complete, Tidal Bedside Lab must be presented as an education tool with unreviewed physiological parameters (see [INTENDED_USE.md](INTENDED_USE.md) and [VALIDATION.md](VALIDATION.md)).

This dossier is meant to be sent as it is to one or two clinicians (a practising anaesthetist and an emergency physician or intensivist). It lists the 23 items that the literature review (`ER anesthesia simulator references.md`) could not settle, the value the engine uses today, and the decision each reviewer is asked to make. Values are quoted from the source files at the time of writing; the engine hash to which a sign-off applies is recorded in section 4.

## 1. How to review

1. Read the intended use (INTENDED_USE.md): the simulator teaches decision sequences to residents; it does not predict outcomes for real patients.
2. For each row in section 3, choose one outcome in the last column of section 4: **Accept** (value is acceptable for teaching), **Change** (give the replacement value and a source), or **Remove** (feature should not ship until sourced).
3. A reviewer needs no access to the code. Anything marked "tunable" can be changed by a developer in the named file without touching the rest of the engine.
4. Evidence grades used in the status column: **primary-checked** (read on the authority's own page), **cross-matched** (equation read in open-access text and matched by an independent implementation; original paper not opened), **secondary** (one review, calculator or library), **unverified** (no source), **contradictory** (two sources disagree), **model-only** (output of the engine, not a measurement).
5. Reviewers are asked to judge teaching plausibility, not to certify the engine as a medical device.

## 2. What was and was not checked

- Checked against the publisher's pages: the AHA 2025 resuscitation numbers (rate, depth, compression fraction, epinephrine timing, post-ROSC targets).
- Not opened by anyone in this project: the original papers of Marsh 1991, Schnider 1998, Minto 1997 and Eleveld 2018. Their constants were read in open-access reviews and open-source libraries and agree across sources.
- Not obtained: manufacturer labels (openFDA and DailyMed were unreachable), so no dose, onset, half-life or clearance in the drug table comes from a current label.
- Not done: comparison with Pulse or BioGears on shared cases, a usability study, any outcome validation.

## 3. The 23 items

Files are relative to `src/engine/`.

### Drugs

| # | Item and value in the engine | Evidence | Question for the reviewer |
|---|---|---|---|
| 1 | **Eleveld propofol.** V1 = 6.28 L (scaled by body weight with a sigmoid); Q2 = 1.75 x (V2/25.5)^0.75 x (1 + 1.30 x (1 - maturation)). Published sources give V1 6.28 (abstract, libraries) or 6.25 (one review table); the Q2 maturation term and the 2018 corrigendum (PMID 30032904) are unread. `drugs.js` `propofolEleveld` | Contradictory | Is a difference of a few percent in adult Q2 or V1 acceptable for teaching induction dosing? If not, the authors' reference code must be obtained. |
| 2 | **Marsh propofol.** k13 = 0.0419, k31 = 0.0033 per min (PyTCI gives 0.042 and 0.0031); default ke0 = 0.26 per min (1.2 per min is the "modified Marsh" value). Time to peak effect differs by about 2.4x between the two variants. `drugs.js` `propofolMarsh` | Contradictory, resolved by choice | Which ke0 should a teaching simulator default to, and should the choice be displayed on screen? |
| 3 | **Eleveld remifentanil.** Weight maturation uses SE50 = 2.88 kg (both open libraries); one source gives 17.8 kg. Adult clearance changes by -3.5 % to +4.7 % in tests. `drugs.js` `remifentanilEleveld` | Contradictory | None clinically relevant for adults is expected; confirm or ask for the paper to be checked. |
| 4 | **Hypnotic effect model.** Propofol Ce50 = 3.08 ug/mL x exp(-0.00635 x (age - 35)), gamma 2.5, opioid synergy lowers Ce50 by up to 40 % at about 3 ng/mL fentanyl-equivalent; loss of consciousness when effect > 0.30; displayed BIS = 92 - 86.7 x effect. `drugs.js` PD block | Unverified (BIS curve, interaction, LOC threshold) | Are loss-of-consciousness concentrations, the opioid synergy size and the BIS mapping plausible for a typical induction? |
| 5 | **Haemodynamic and ventilatory drug effects.** Propofol: ventilatory depression C50 2.0 ug/mL (gamma 3, Emax 0.97), haemodynamic C50 2.0 (SVR -42 %, inotropy -25 %, venous tone -30 % at full effect). Remifentanil: ventilatory C50 0.92 ng/mL (gamma 2, Emax 0.98), bradycardia up to 25 %. Apnoeic threshold PaCO2 about 36.75 mmHg shifted by opioid. `drugs.js`, `respiratory.js` | Unverified (remifentanil C50 secondary) | Do the MAP fall after a normal induction dose and the time to apnoea after an opioid bolus look right? |
| 6 | **Other hypnotics, opioids, relaxant PK.** Fentanyl (V1 6.09 L, ke0 0.12), ketamine (V1 0.063 L/kg, ke0 0.652), midazolam (two parameter sets, ke0 0.11 or 0.08), etomidate (V1 4.45 L, ke0 0.447), dexmedetomidine, rocuronium (V1 0.044 L/kg, ke0 0.107). All from one open library. `drugs.js` | Secondary | Spot-check onset and offset of each against clinical experience (e.g. etomidate induction time, ketamine duration). |
| 7 | **Neuromuscular block.** Rocuronium Ce50 1.2 ug/mL, gamma 3.5 (about 90 % twitch depression at 60 s for 1.2 mg/kg); succinylcholine Ce50 1.2, gamma 3.0, k10 1.0 per min, ke0 0.3; sugammadex binds 0.28 mg rocuronium per mg (1:1 molar), complexation rate 3 per min (design). Dosing-weight choice (total, ideal, lean) is a preset in the UI. `drugs.js` | Unverified | Are onset, duration and sugammadex reversal times acceptable? Which dosing weight should each relaxant default to in obesity? |
| 8 | **Label data.** Dose presets, onset, half-life, volume of distribution, clearance, protein binding for every drug are design values or library values, not label values. `drugs.js` | Unverified | Provide the labels your institution uses; they will replace the design values. |
| 9 | **Calcium chloride "ampoule".** The engine works in mg of calcium chloride (UI preset 1000 mg, step 500 mg; C50 25 mg/L, half-life 6 min). Sources disagree on what one ampoule delivers: 5 mmol per 10 mL (one convention) against 1.4 mEq/mL, about 7 mmol per 10 mL (US label) - about 40 % apart. `drugs.js`, `web/ui.js` | Contradictory conventions | Which salt, dose and display unit should the simulator use? |

### Body size and composition

| # | Item and value in the engine | Evidence | Question for the reviewer |
|---|---|---|---|
| 10 | **Watson total body water.** Male: 2.447 - 0.09516 x age + 0.1074 x height + 0.3362 x weight; female: -2.097 + 0.1069 x height + 0.2466 x weight; capped at 75 % of body weight. Some calculators use -0.09156 for the male age term. `anthropometrics.js` | Contradictory, resolved to the original | Confirm; an age-80 unit test is planned. |
| 11 | **Predicted body weight.** 50 kg (male) or 45.5 kg (female) + 0.91 x (height - 152.4 cm). Some sources give 45 for women. `anthropometrics.js` | Contradictory | Confirm 45.5. |
| 12 | **Blood volume.** Nadler below BMI 28, Lemmens (70 / sqrt(BMI/22) mL/kg) above BMI 32, blended in between. The two rules differ by about 17 % at BMI 82. `anthropometrics.js` | Design choice | Is the blend acceptable for BMI 35-55 patients (haemorrhage tolerance, volume of distribution)? |
| 13 | **Composition and normal values.** Venous haematocrit 0.40 (F) / 0.45 (M); whole-body factor 0.91; extracellular water 40 % of total body water; plasma 58 % of blood volume; cardiac index 3.0 (F) / 2.8 (M) L/min/m2, -0.8 % per year over 40, -12 % at BMI 50; MAP 87 mmHg + 0.25 per year over 40; heart rate 72. `anthropometrics.js`, `fluids.js`, `cardio.js` | Unverified / design | Do these resting values look right for a typical adult, an older adult and an obese adult? |

### Gas exchange

| # | Item and value in the engine | Evidence | Question for the reviewer |
|---|---|---|---|
| 14 | **Lung volumes.** Upright FRC = 3.0 L x (height/175)^2.6 (x 0.80 for women); supine x 0.80; awake FRC x exp(-0.03 x (BMI - 25)); under anaesthesia a further x (0.80 - 0.20 x clamp((BMI - 28)/12, 0..1)); PEEP adds 2 % per cmH2O up to 15. Back-fitted to Jense 1991 and Farmery-Roe, not taken from a published regression. `respiratory.js` | Unverified (back-fit) | Replace with a regression you trust, or confirm the resulting apnoea times (item 15) look right. |
| 15 | **Apnoeic desaturation.** Time to SpO2 90 % at BMI above 50 and in frail elderly adults, and the 90 to 60 % interval, are model output. Only Jense 1991 (364, 247 and 163 s to 90 %) anchors the model; test bands were widened (90 to 60 % within 20-70 s). `respiratory.js`, `tests/respiratory.test.js` | Model-only | State the apnoea time you would expect for a pre-oxygenated patient at BMI 25, 40 and 55, and for a frail 80-year-old. |
| 16 | **Gas-exchange structure.** Farmery-Roe-type O2/N2 pools, CO2 store, tissue N2 capacitance, and the rise of PaCO2 during apnoea (Eger-Severinghaus-type). The original papers were not read and the Benumof table attribution is contradictory. `respiratory.js` | Unread / contradictory | Does PaCO2 rise (roughly 3-6 mmHg per minute of apnoea) look plausible? |
| 17 | **Gas constants.** Hufner 1.34 mL O2/g Hb (sources give 1.31-1.39); O2 solubility 0.0031 mL/dL/mmHg; Henderson-Hasselbalch pK 6.1 with 0.0307; venous-arterial CO2 slope 6.7 mL/L/mmHg; anatomical dead space 2.2 mL/kg predicted weight; hypercapnic ventilatory slope scaled to CO2 production. `respiratory.js` | Contradictory / unverified | Accept within +/-5 %, or replace. |

### Haemodynamics, fluids, temperature

| # | Item and value in the engine | Evidence | Question for the reviewer |
|---|---|---|---|
| 18 | **Circulation constants.** Mean systemic filling pressure 8 mmHg (sources give 7 or 8), CVP 4 mmHg, stressed volume 30 % of blood volume, Starling steepness lambda 5.8, baroreflex gains (heart rate 2.1, vascular 0.8, venous 0.5) and time constants tuned to reproduce Pulse's haemorrhage response (HR +30 %, CO -15 to -20 %, SVR +10 to +15 %). The pulmonary circuit is not modelled separately. `cardio.js` | Contradictory / unverified | Does the compensation to a 15-30 % blood loss look right (heart rate, pressure, time course)? |
| 19 | **Fluid and oxygen-delivery kinetics.** Crystalloid distribution half-life 8 min, plasma retains about 30 % once distributed (sources give 15-20 % to 25-30 %); refill 0.03 per min; urine elimination 0.023 per min awake, much lower under anaesthesia; critical oxygen delivery = 2 x VO2 (clinical range 4-8 mL/kg/min); lactate production and clearance are design values; blood units: red cells 300 mL (Hct 0.60), whole blood 500 mL (Hct 0.40), plasma 250 mL; haemorrhage classes are used qualitatively only (ATLS 11 table not verified). `fluids.js`, `respiratory.js` | Contradictory / unverified | After 1 L of saline in a 70 kg adult, how much stays in the circulation at 30 minutes? Is a transfusion response on Hb and BP plausible? |
| 20 | **Temperature.** Body specific heat 3.47 kJ/kg/C; vasoconstriction threshold 36.8 C awake and 34.5 C anaesthetised; shivering threshold 36.0 C awake and 33.5 C anaesthetised (paralysed patients do not shiver); non-shivering thermogenesis is a design term; behaviour beyond BMI 35 and age effects are unverified. `thermal.js` | Unverified | Are core-temperature fall under anaesthesia (about 1-1.5 C in the first hour) and rewarming rates plausible? |

### Resuscitation

| # | Item and value in the engine | Evidence | Question for the reviewer |
|---|---|---|---|
| 21 | **Guideline defaults.** AHA 2025: rate 100-120/min, depth 5-6 cm, chest compression fraction at least 60 %, change compressor about every 2 min, epinephrine 1 mg every 3-5 min, single shocks. The ERC 2025 numbers were read from a mirror only. No ERC profile exists. `cpr.js`, `scenarios.js` | Primary-checked (AHA); secondary (ERC) | Confirm AHA 2025 as the default and say whether an ERC profile is needed for your trainees. |
| 22 | **Content not retrieved.** Bradycardia drug doses, special-circumstance arrests, ECPR, ACS anticoagulation and fibrinolysis, nitroglycerin dosing units (the research flagged a possible unit error in one source). The engine includes atropine, nitroglycerin, adenosine, thrombolysis and PCI with design values. `drugs.js`, `patient.js`, `scenarios.js` | Not retrieved | Review the STEMI scenario's drug list, doses and timing against your local protocol. |
| 23 | **Arrest and rhythm model.** CPR flow at best 30 % of normal output (x(1 - 0.15 x obesity)); depth, rate and recoil quality shapes; 20 % depth lost on a soft surface without a board; compressor fatigue after 2 min; shock success 150 J about 90 %, 200 J about 93 % (reduced by impedance, readiness and VF amplitude); impedance 70 + 1.5 x (BMI - 25) ohm; charge time 4 + energy/120 s; VF amplitude fades over about 8 min without flow; spontaneous ROSC hazard per minute (PEA 0.03, or 0.07 once the cause is treated; asystole 0.008, or 0.02 once treated), scaled by myocardial readiness; rhythm, pleth and arterial waveforms and alarm defaults are synthetic. `cpr.js`, `rhythm.js`, `web/monitor.js` | Unverified (design) | Do ROSC chances, time to VF coarseness loss and the effect of poor CPR look right? Which alarm defaults would you use? |

## 4. Sign-off

Record the build to which the review applies: run `npm run build` and copy `engineSha256` from `dist/BUILD.json`.

| Field | Entry |
|---|---|
| Engine hash reviewed | |
| Reviewer name, role, institution | |
| Date | |
| Conflicts of interest | |

| # | Accept / Change / Remove | Replacement value or comment | Source |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |
| 11 | | | |
| 12 | | | |
| 13 | | | |
| 14 | | | |
| 15 | | | |
| 16 | | | |
| 17 | | | |
| 18 | | | |
| 19 | | | |
| 20 | | | |
| 21 | | | |
| 22 | | | |
| 23 | | | |

## 5. Surgical gestures (added after the first 23 items)

Items 24-28 are not yet signed off. Files are relative to `src/engine/`; every constant is a design value except where a reference tag is given.

| # | Item | Where | Question for the reviewer |
|---|---|---|---|
| 24 | Needle decompression: catheter must exceed chest-wall thickness + 3 mm; thickness by site and BMI; patency; left-lateral cardiac risk | `surgical.js` (`SITES`, `Chest.decompress`) | Are the site means/slopes (REF ahmad2025, laan2016) and the failure rates at 5, 7 and 8 cm acceptable for teaching? |
| 25 | Tension pneumothorax physiology: leak under positive pressure, airway pressure, venous return, pump depression, shunt, ventilation, CPR flow | `surgical.js`, `patient.js`, `cardio.js`, `respiratory.js` | Do time to collapse (arrest in about 9 min untreated at PEEP 5, R-sided) and the recovery after decompression look right? |
| 26 | Chest drain: 28 Fr default, insertion time, drainage rate, malposition, leak sealing | `Chest.insertTube`, `patient.js` `_chestTube` | Are 2-3 min and the malposition rate reasonable? Should a finger thoracostomy step be modelled? |
| 27 | Front-of-neck access: scalpel-bougie-tube vs. cannula, palpation by BMI and sex, vertical incision, ultrasound marking | `surgical.js` (`pPalpable`, `fonaPlan`, `Neck`) | Do success rates and times match local experience (REF umek2020, rees2019, lavelle2021, das2015)? |
| 28 | Scenarios `tension_ptx` and `cico` and their scoring weights/time limits | `scenarios.js` | Are the stories, thresholds (90 s relief, 60 s to neck access) and teaching points correct? |

## 5b. Infectiology ward (added with the infectiology mode)

Reviewer: an infectious-diseases physician or clinical microbiologist, ideally with an antimicrobial pharmacist.

- **INF-1 Breakpoints**: compare `BREAKPOINTS` in `src/engine/infection.js` with EUCAST v16.1 (Enterobacterales, S. aureus, S. pneumoniae rows used) and the inference rules in `categorize()` (cefoxitin for staphylococcal beta-lactams with MSSA cephalosporins reported I, pneumococcal penicillin screen, "-" reported R).
- **INF-2 Doses**: the `ABX` catalogue shows the EUCAST v16.1 standard/high dosages, gentamicin 6-7 mg/kg and amikacin 25-30 mg/kg of actual weight, vancomycin loading 25 mg/kg (max 3 g). Decide whether an adjusted body weight should be shown in obesity and whether renal dose adjustment must be modelled.
- **INF-3 Cases**: the four isolates' MICs are invented. Check that each antibiogram is plausible and that the expected management is what you would teach (pyelonephritis with bacteraemia, severe CAP, line-related MSSA bacteraemia, ESBL urosepsis with shock).
- **INF-4 Scoring**: criteria in `infCriteria` (`src/engine/scenarios.js`): cultures before antibiotics, time to first dose (1 h / 3 h), empirical activity and unneeded MRSA / double Gram-negative cover, narrowing within 24 h of the antibiogram, oral switch once stable, duration bands (7 days BALANCE, >= 5 days CAP, 14 days from clearance for SAB), line removal, follow-up cultures, TTE, 30 mL/kg fluids, lactate, carbapenem for ESBL bacteraemia.
- **INF-5 Course model**: the host-course constants listed in VALIDATION section 2 (stability within 1-4 days on active therapy, ICU within 3 days untreated, relapse after 3 days of therapy).
- **INF-6 Not covered**: AWaRe categories (source not retrievable), allergy, drug toxicity and levels, C. difficile, local resistance rates.

## 6. Beyond the items above

- **Scenarios**: review the clinical story, the scripted events and the scoring criteria of the eight scenarios in `scenarios.js` (STEMI to VF, witnessed VF, opioid overdose to hypoxic PEA, rapid-sequence induction at BMI 45, haemorrhage, tension pneumothorax, can't intubate can't oxygenate, endobronchial tube with secretions), and the tube-depth and secretion model in `ett.js`. Weights and time thresholds are educational choices and have not been tested against learner outcomes.
- **Wording**: check the on-screen drug names, units and debrief texts in English and French.
- **Release gate**: after Change or Remove decisions are applied, `npm run verify` must pass, and a new hash must be recorded.
