# Clinical review: proposed answers

Status: **proposals prepared with AI assistance on 2026-11-18 from published guidelines and papers, for the prototype. Not a clinician sign-off.** Every item in [CLINICAL_REVIEW.md](CLINICAL_REVIEW.md) stays open until a named clinician completes section 4 there. This file gives the reviewer a proposed answer for each item, the evidence behind it, and what the simulator actually does (measured on the engine, not read from the code), so that most items need only "agree" or a replacement value.

Build these proposals apply to: run `npm run build` and read `engineSha256` in `dist/BUILD.json` (it now also records `eucastVersion`).

How to read each row:
- **Engine does**: measured with the simulator on 2026-11-18 (70 kg, 40-year-old man unless stated).
- **Published**: what the guideline or paper says. Citations are the papers named; where only a summary or abstract was read, it says so.
- **Proposal**: Accept, Changed (already applied in this build, with the old value), or Open (a change is suggested but not applied, because it needs a model change or a clinical choice).

## Summary

| Outcome | Items |
|---|---|
| Changed in this build | 7 (relaxants and sugammadex), 20 (rewarming), plus a bug fix found during the review (hypoxic bradycardia never recovered) and INF-1 (EUCAST version in the build record). Earlier: 9 (calcium in mmol), 12 (blood volume blend) |
| Accept as is | 1, 3, 6, 8 (with caveat), 10, 11, 13, 16, 17, 18, 19, 22, 23, 24, 25, 26, 28 |
| Open: change suggested, not applied | 2 (show the Marsh ke0 on screen), 4/5 (induction hypotension in the elderly, fentanyl in the awake patient), 14/15 (apnoea time in the frail elderly), 21 (ERC profile), 27 (re-read against DAS 2025) |
| Needs the clinician | 9 and 12 (the remaining clinical choices), INF-3 to INF-6 |

## Drugs

| # | Engine does | Published | Proposal |
|---|---|---|---|
| 1 | Eleveld propofol, V1 6.28 L | Eleveld 2018 gives 6.28 L; the 6.25 in one review is rounding. A few percent on V1 or Q2 changes the induction dose by less than the variation between patients. | **Accept** for teaching. |
| 2 | Default propofol model is Eleveld. Marsh is available with ke0 0.26/min ("marsh") or 1.2/min ("marsh-mod"). | Marsh 1991 had no ke0; 0.26/min is the Diprifusor value, 1.21/min (Struys 2000) gives a time to peak effect of about 1.6 min, close to Schnider. | **Accept** Eleveld as default. **Open**: label the two Marsh variants with their ke0 on screen, since peak effect differs about 2.4x. |
| 3 | Remifentanil Eleveld maturation SE50 2.88 kg | Irrelevant for adults (the maturation term saturates); adult clearance changes by less than 5 %. | **Accept.** |
| 4 | Propofol 2 mg/kg: loss of consciousness at 60 s (41 s at 75 y), BIS minimum 47 (31 at 75 y) | Loss of consciousness 30-60 s after 2-2.5 mg/kg; BIS 40-60 is the target for anaesthesia; older patients are more sensitive. | **Accept.** |
| 5 | Propofol 2 mg/kg ventilated: MAP nadir -19 % at 40 y, -22 % at 75 y, at about 5.5 min. Fentanyl 2 mcg/kg awake: alveolar ventilation down to 20 % of baseline, PaCO2 +12 mmHg. | MAP falls 20-30 % after induction, more in older patients (often 30-40 %). Fentanyl 1-2 mcg/kg in an awake adult slows breathing and raises PaCO2 by about 5-10 mmHg; apnoea is uncommon at that dose awake. | **Accept** at 40 y. **Open**: the elderly fall looks small (-22 %) and the awake fentanyl depression looks strong; both are calibration changes to the haemodynamic and ventilatory C50s, best set with the reviewer's experience. |
| 6 | Library PK for fentanyl, ketamine, midazolam, etomidate, dexmedetomidine | Values match the open libraries and their source papers. | **Accept**; spot-check by the reviewer during a demo. |
| 7 | **Changed.** Now: rocuronium 0.6 mg/kg about 98 % block at 2 min, 25 % recovery at 34 min; 1.2 mg/kg > 92 % at 47 s, 25 % recovery at 56 min, TOF ratio 0.9 at about 2 h. Succinylcholine 1 mg/kg > 90 % at 43 s, 25 % recovery at 6.7 min. Sugammadex: 16 mg/kg 3 min after rocuronium 1.2 mg/kg gives TOF ratio 0.9 in 2.4 min; 2 mg/kg at TOF count 2 in 1.4 min; 4 mg/kg at a deep block in 1.7 min. Neostigmine 50 mcg/kg at TOF count 2: TOF ratio 0.9 in 16 min. | Rocuronium label: clinical duration 31 min (0.6 mg/kg) and 73 min (1.2 mg/kg); onset about 90 s and 55-60 s (Magorian 1993). Succinylcholine 1 mg/kg: complete block in about 60 s, 90 % recovery in about 10 min (Naguib 2003). Sugammadex label: about 1.5-3 min at each of its three doses. Neostigmine at TOF count 2: about 10-20 min. | **Changed.** Before: rocuronium 0.6 mg/kg never reached a full block (96 %), succinylcholine stopped at 92 % and wore off at 4.3 min, sugammadex reversed in 24-64 s. Now rocuronium C50 1.05 ug/mL (was 1.2), gamma 4 (was 3.5); succinylcholine C50 0.7 (was 1.2), ke0 0.2/min (was 0.3); sugammadex reversal follows the receptor unbinding (1.5/min) instead of being instantaneous; neostigmine shift 2 (was 3). Dosing weight: **propose** rocuronium on ideal body weight, succinylcholine on total body weight, sugammadex on total body weight (label). |
| 8 | Doses, half-lives and clearances come from libraries and textbooks, not labels | Labels were not reachable. | **Accept for a prototype**; replace with the institution's labels before any formal use. |
| 9 | Calcium in mmol of elemental calcium; chloride 10 % 0.68 mmol/mL (6.8 mmol per 10 mL), gluconate 10 % 0.22 mmol/mL (6.6 mmol per 30 mL) | Calcium chloride dihydrate 10 %: 1 g = 6.8 mmol (MW 147). ERC and UK hyperkalaemia guidance: 10 mL calcium chloride 10 % or 30 mL gluconate 10 %, about 6.6-6.8 mmol. The "5 mmol per 10 mL" figure fits a weaker presentation, not the 10 % solution. | **Accept** the present values for 10 % solutions. The clinician should confirm which presentation their hospital stocks. |

## Body size and composition

| # | Engine does | Published | Proposal |
|---|---|---|---|
| 10 | Watson male age term -0.09516 | Watson 1980 original paper: -0.09516. | **Accept.** |
| 11 | Predicted body weight, women 45.5 kg + 0.91 x (height - 152.4) | ARDSNet protocol (ARMA 2000): 45.5 kg for women. | **Accept.** |
| 12 | Smooth Nadler-to-Lemmens blend over BMI 27-45 (changed earlier) | Lemmens 2006 was derived in mixed-sex obese patients and has no sex term. | **Accept** the window and the sex-neutral rule for teaching. |
| 13 | Haematocrit 0.40/0.45, MAP 87 rising 0.25/year after 40, HR 72, cardiac index 2.8-3.0 | Normal ranges: haematocrit 0.36-0.46 (F) / 0.41-0.50 (M), cardiac index 2.5-4.0 L/min/m2, MAP rises with age. | **Accept.** |

## Gas exchange

| # | Engine does | Published | Proposal |
|---|---|---|---|
| 14-15 | Pre-oxygenated apnoea, time to SaO2 90 %: BMI 24 473 s, BMI 40 197 s, BMI 55 110 s, frail 80-year-old (Hb 11, cardiac output 80 %) 534 s | Jense 1991: 364 s (normal), 247 s (moderately obese), 163 s (morbidly obese). Benumof 1997 model: healthy 70 kg about 8 min, moderately ill adult about 5.5 min, obese 127 kg under 3 min. | **Accept** for BMI 24-55. **Open**: the frail elderly patient should desaturate sooner than a healthy adult, not later. The model has no age-related closing capacity (airway closure above FRC when supine under anaesthesia); adding it is a model change. Proposed target: 4-6 min. |
| 16 | PaCO2 rise in apnoea: +7 mmHg in the first minute, then about 2.4 mmHg/min | Eger and Severinghaus 1961, Stock 1988: about 8-16 mmHg in the first minute, then about 3-4 mmHg/min. | **Accept**; slightly slow but within teaching tolerance. |
| 17 | Hufner 1.34, solubility 0.0031, pK 6.1 | Textbook values; measured Hufner 1.31-1.36. | **Accept.** |

## Haemodynamics, fluids, temperature

| # | Engine does | Published | Proposal |
|---|---|---|---|
| 18 | 20 % blood loss over 10 min, awake: HR +24 %, MAP -6 %, cardiac output -10 %, SVR +9 %. 35 % loss: HR 115, MAP 75 | ATLS class II (15-30 %): tachycardia, normal or slightly low pressure; class III (30-40 %): HR > 120 and falling pressure. | **Accept**; class III hypotension is mild but acceptable. |
| 19 | 1 L crystalloid over 15 min, awake: 27 % in the plasma at 30 min, 16 % at 60 min | Volume kinetics in awake volunteers (Hahn): about 15-25 % at 30 min, less later; more is retained under anaesthesia. | **Accept.** |
| 20 | **Changed.** Core temperature under general anaesthesia: -1.0 C in the first hour, -0.6 C in the second. Recovery from 34.5 C: +0.7 C in the first hour passively; forced-air warming (50 W) reaches 36 C about 45 min sooner. | Sessler 2016: 1-1.5 C in the first hour of anaesthesia. Cochrane CD009892: passive rewarming 0.70 C/h; forced air shortens the time to normothermia by about 1-1.5 h. Forced-air blankets transfer about 30-60 W. | **Changed.** Before: passive rewarming about 2.6 C/h. Shivering heat is now produced in the peripheral compartment (muscle), not in the core; its size is about the basal heat (was about 130 W); non-shivering thermogenesis 10 % of basal (was 50 %, negligible in adults); the warmer button now delivers 50 W (was up to 300 W). |

## Resuscitation

| # | Engine does | Published | Proposal |
|---|---|---|---|
| 21 | AHA 2025 defaults: epinephrine after the 2nd shock | ERC 2025 ALS: adrenaline and amiodarone after the 3rd shock in shockable rhythms; early adrenaline in non-shockable rhythms. RCUK: no major change from 2021. | **Accept** AHA as default. **Open**: add an ERC profile (drug timing after the 3rd shock) because the trainees are French-speaking and ERC is the European standard. This is a feature, not a value change. |
| 22 | Aspirin 324 mg button, nitroglycerin infusion in mcg/min, atropine 1 mg | ESC/ERC: aspirin 150-300 mg loading (AHA 162-325 mg); nitroglycerin IV 10-200 mcg/min; bradycardia: atropine 0.5 mg (ERC) or 1 mg (AHA) up to 3 mg. | **Accept.** Units are consistent (mcg/min). |
| 23 | First-shock success about 90-93 %, PEA spontaneous ROSC hazard 0.03/min | Biphasic first-shock termination 85-95 %. In-hospital non-shockable arrest with full ALS: ROSC in roughly half. | **Accept**; the hazard applies with treatment and scales with myocardial readiness, so 45 % at 20 min is within the in-hospital range. |

## Surgical gestures (24-28)

| # | Proposal |
|---|---|
| 24 | **Accept.** Needle failure with a 5 cm catheter at the 2nd intercostal space in the mid-clavicular line is often reported around 30-40 % in meta-analyses (Laan 2016); ATLS 10th edition moved adult decompression to the 4th/5th space, mid-axillary line. |
| 25 | **Accept** for teaching (arrest about 9 min untreated is a design choice). |
| 26 | **Accept.** A finger thoracostomy step could be added later. |
| 27 | **Open.** The DAS guidelines were updated: *Difficult Airway Society 2025 guidelines for management of unanticipated difficult tracheal intubation in adults*, Br J Anaesth 2026;136:283-307 (PubMed record read; full text not read). They keep Plan A to Plan D with front-of-neck access as Plan D and make videolaryngoscopy first-line for Plan A. The `cico` case should be re-read against the full text; its scalpel-bougie-tube technique is consistent with the summary. |
| 28 | **Accept**; thresholds (90 s to relief, 60 s to neck access) are teaching choices. |

## Infectiology ward

| # | Proposal |
|---|---|
| INF-1 | **Changed (engineering).** EUCAST v16.1 is current (valid 24 June - 31 December 2026, eucast.org). The build record now stores `eucastVersion` next to the engine hash. The breakpoint values themselves were not re-checked row by row. |
| INF-2 | **Open, for the infectious-diseases reviewer**: show adjusted body weight for aminoglycosides in obesity (common practice); renal dose adjustment not modelled. |
| INF-3 to INF-6 | **For the reviewer.** No proposals: the MICs are invented teaching data and need a microbiologist's judgement. |

## Found during the review (not in the dossier)

- **Bug fixed:** after a hypoxic episode the rhythm stayed "sinus bradycardia" permanently, even once the saturation was back to normal. Hypoxic bradycardia now resolves when oxygenation is restored (only when hypoxia caused it; an instructor-injected or scenario bradycardia is unchanged).
- The recovery-room case (`pacu_ponv`) now starts at 35.2 C and lasts 60 min, because with realistic rewarming nobody can reach 36 C within 30 min.

## Sources checked on the web for this file (2026-11-18)

- DAS 2025 guidelines, PubMed record: https://pubmed.ncbi.nlm.nih.gov/41203471/ and https://das.uk.com/new-das-2025-intubation-guidelines/
- ERC 2025 ALS (draft for comments): https://cprguidelines.eu/assets/other-documents/ALS_-ERC-G2025-for-public-comments.pdf ; RCUK summary: https://www.resus.org.uk/professional-library/2025-resuscitation-guidelines/executive-summary-main-changes-2021-guidelines
- EUCAST clinical breakpoints v16.1: https://eucast.org/clinical_breakpoints/
- Cochrane review, treating postoperative hypothermia (CD009892): https://doi.org/10.1002/14651858.CD009892.pub2

The other figures are from the papers and labels named in each row, recalled rather than re-read for this file; the reviewer should treat them as pointers.
