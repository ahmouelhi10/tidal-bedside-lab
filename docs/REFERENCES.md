# References

Generated from `src/engine/references.js` by `npm run docs` - do not edit by hand. Total entries: 92.

Every engine constant that is not a pure convention carries a `REF <id>` tag in code, tests or docs; `tests/references.test.js` fails if a cited id is missing from the registry or an entry is never used. Status meanings:

- **VERIFIED** - checked against the primary text/abstract, or against at least two concordant independent sources, in the project research notes.
- **SECONDARY** - taken from a review, a software library or a teaching page; the primary paper was not read.
- **UNVERIFIED** - a design value or textbook recollection. A clinician or physiologist must review it before any educational claim relies on it (see VALIDATION.md).

## Verified (55)

Primary source or two concordant independent sources.

| id | use | citation |
|---|---|---|
| `mosteller1987` | cited in code/tests | Mosteller RD. Simplified calculation of body-surface area. N Engl J Med 1987;317:1098 |
| `dubois1916` | cited in code/tests | Du Bois D, Du Bois EF. A formula to estimate the approximate surface area. Arch Intern Med 1916;17:863 |
| `devine1974` | cited in code/tests | Devine BJ. Gentamicin therapy. Drug Intell Clin Pharm 1974;8:650 |
| `james1976` | cited in code/tests | James WPT. Research on obesity. HMSO 1976 (as printed in Absalom 2009 / arXiv 2309.04787) |
| `janmahasatian2005` | cited in code/tests | Janmahasatian S et al. Quantification of lean bodyweight. Clin Pharmacokinet 2005;44:1051 |
| `hume1966` | cited in code/tests | Hume R. Prediction of lean body mass from height and weight. J Clin Pathol 1966;19:389 |
| `watson1980` | cited in code/tests | Watson PE, Watson ID, Batt RD. Total body water volumes for adult males and females. Am J Clin Nutr 1980;33:27 (male age coefficient -0.09516) |
| `nadler1962` | cited in code/tests | Nadler SB, Hidalgo JU, Bloch T. Prediction of blood volume in normal human adults. Surgery 1962;51:224 |
| `lemmens2006` | cited in code/tests | Lemmens HJM et al. Estimating blood volume in obese and morbidly obese patients. Obes Surg 2006;16:773 |
| `mifflin1990` | cited in code/tests | Mifflin MD et al. A new predictive equation for resting energy expenditure. Am J Clin Nutr 1990;51:241 |
| `pulse_cv_2024` | cited in code/tests | Kitware Pulse Physiology Engine, Cardiovascular methodology (baroreceptor sigmoid nu=4, shock definitions) <https://pulse.kitware.com/_cardiovascular_methodology.html> |
| `kitware_swine2025` | background | Kitware. Improved hemorrhage and resuscitation simulations validated with swine data (2025) |
| `barnes2020` | background | Barnes et al. Comparing hemorrhage in human physiology simulation tools. Simul Healthc 2020;15:310 |
| `hahn2024` | cited in code/tests | Hahn RG. Volume kinetics of crystalloid fluid, Front Physiol 2024;15:1439035 |
| `severinghaus1979` | cited in code/tests | Severinghaus JW. Simple, accurate equations for human blood O2 dissociation computations. J Appl Physiol 1979;46:599 (inverse verified on Physiome page; forward cross-checked within 0.53 sat points) |
| `dash2010` | background | Dash RK, Bassingthwaighte JB. Erratum to Blood HbO2 and HbCO2 dissociation curves. Ann Biomed Eng 2010 (Hill n=2.7, P50 26.8 mmHg) |
| `alveolar_gas` | background | Alveolar gas equation with PB 760, PH2O 47, R 0.8 (GlobalRPh A-a gradient page) |
| `magnusson2003` | cited in code/tests | Magnusson L, Spahn DR. New concepts of atelectasis during general anaesthesia. Br J Anaesth 2003;91:61 |
| `jense1991` | cited in code/tests | Jense HG et al. Effect of obesity on safe duration of apnea in anesthetized humans. Anesth Analg 1991;72:89 (364/247/163 s to SpO2 90%) |
| `srinivas2011` | cited in code/tests | Srinivas et al. Expiratory reserve volume in obese vs non-obese adults. J Clin Diagn Res 2011 (ERV -48%) |
| `taha2006` | background | Taha S et al. Nasopharyngeal oxygen insufflation following pre-oxygenation. Anaesthesia 2006;61:427 (ETCO2 +2.3-2.4 mmHg/min under apnea) |
| `hardie2004` | cited in code/tests | Hardie JA et al. Reference values for arterial blood gases in the elderly. Chest 2004 |
| `eger1961` | background | Eger EI, Severinghaus JW. The rate of rise of PaCO2 in the apneic anesthetized patient. Anesthesiology 1961;22:419 (citation only) |
| `ed_apnea` | background | ED RSI apnea blood-gas series, Am J Emerg Med (PaCO2 +11.5 mmHg, pH -0.05; >=60 s apnea -0.15) |
| `nieuwenhuijs2012` | background | Nieuwenhuijs D et al. Opioid ventilatory depression in post-operative patients. Br J Anaesth 2012 |
| `marsh1991` | cited in code/tests | Marsh B et al. Pharmacokinetic model driven infusion of propofol in children. Br J Anaesth 1991;67:41 (k13 0.0419, k31 0.0033) |
| `schnider1998` | cited in code/tests | Schnider TW et al. The influence of method of administration and covariates on the pharmacokinetics of propofol in adult volunteers. Anesthesiology 1998;88:1170 (ke0 0.456 per 1999) |
| `eleveld2018` | cited in code/tests | Eleveld DJ et al. Pharmacokinetic-pharmacodynamic model for propofol for broad application in anaesthesia and sedation. Br J Anaesth 2018;120:942 (typical values verified; V1 6.28; corrigendum PMID 30032904 unread) |
| `minto1997` | cited in code/tests | Minto CF et al. Influence of age and gender on the pharmacokinetics and pharmacodynamics of remifentanil I. Anesthesiology 1997;86:10 |
| `eleveld2017` | cited in code/tests | Eleveld DJ et al. An allometric model of remifentanil pharmacokinetics and pharmacodynamics. Anesthesiology 2017;126:1005 (supplement NONMEM code) |
| `absalom2009` | cited in code/tests | Absalom AR, Mani V, De Smet T, Struys MMRF. Pharmacokinetic models for propofol - defining and illuminating the devil in the detail. Br J Anaesth 2009;103:26 |
| `sahinovic2018` | cited in code/tests | Sahinovic MM, Struys MMRF, Absalom AR. Clinical pharmacokinetics and pharmacodynamics of propofol. Clin Pharmacokinet 2018;57:1539 |
| `jeleazcov2015` | cited in code/tests | Jeleazcov C et al. Pharmacodynamic response modelling of arterial blood pressure in adult volunteers during propofol anaesthesia. Br J Anaesth 2015;115:213 |
| `soehle2010` | background | Soehle M et al. Propofol BIS Emax model (E0 92, Emax 5.3, Ce50 1.94, gamma 1.75, ke0 0.104) 2010 |
| `vellinga2021` | cited in code/tests | Vellinga R et al. Prospective clinical validation of the Eleveld propofol pharmacokinetic-pharmacodynamic model. Br J Anaesth 2021;126:386 (worked example via authors letter) |
| `aha2025_part7` | cited in code/tests | AHA 2025 Guidelines Part 7 Adult Basic Life Support (rate 100-120, depth >=5 cm <=6 cm, CCF >=60%, 30:2) <https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support> |
| `aha2025_part9` | cited in code/tests | AHA 2025 Guidelines Part 9 Adult Advanced Life Support (epinephrine 1 mg q3-5 min; amiodarone 300/150; lidocaine 1-1.5/0.5-0.75 mg/kg; vasopressin, routine calcium and bicarbonate Class 3) <https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-advanced-life-support> |
| `aha2025_part11` | cited in code/tests | AHA 2025 Guidelines Part 11 Post-Cardiac Arrest Care (SpO2 90-98, PaCO2 35-45, MAP >=65, glucose 70-180, TTM >=36 h) <https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/post-cardiac-arrest-care> |
| `aha2025_algo` | cited in code/tests | AHA 2025 Adult Cardiac Arrest Algorithm description (250725 ed.) |
| `ilcor2025` | background | ILCOR 2025 CoSTR Executive Summary <https://www.ilcor.org/uploads/Executive-Summary-2025-COSTR.pdf> |
| `cares2024` | cited in code/tests | CARES 2024 National Non-Traumatic OHCA Survival Report (ROSC 25.3%; shockable ROSC 43.7%, non-shockable 21.2%) |
| `paradis1990` | cited in code/tests | Paradis NA et al. Coronary perfusion pressure and the return of spontaneous circulation in human cardiopulmonary resuscitation. JAMA 1990;263:1106 (CPP >= 15 mmHg necessary) |
| `reynolds2012` | cited in code/tests | Reynolds JC et al. Coronary perfusion pressure and ROSC in swine, PMC3360119 (pre-shock CPP 31 vs 14 mmHg) |
| `ahmad2025` | cited in code/tests | Ahmad SJS et al. Meta-analysis of the optimal needle length and decompression site for tension pneumothorax. World J Emerg Surg 2025;20:39 (abstract read: 24 radiological studies n=8046, failure to reach the pleura 32.8%, -7.8 percentage points per extra cm, no sex difference in chest-wall thickness, 5th ICS AAL/MAL thinner than 2nd ICS MCL) <https://wjes.biomedcentral.com/articles/10.1186/s13017-025-00613-7> |
| `lesperance_nd` | cited in code/tests | Lesperance RN et al. Retrospective CT review of 335 prehospital needle decompressions (abstract read: 39-76% did not reach the pleural space by two radiological definitions; injured chest wall thicker; an 8-cm catheter at the 5th ICS AAL put the heart at risk in 42%). Year/volume not captured |
| `barton1997` | cited in code/tests | Progressive tension pneumothorax in six anaesthetised ventilated pigs (PMID 9144053, abstract read): SaO2 fell immediately and was below 50% before cardiovascular collapse, i.e. hypoxaemia precedes circulatory failure. Authors/journal from memory (Barton et al., J Emerg Med 1997) |
| `chen2024_side` | cited in code/tests | Chen W et al. Effects of different side tension pneumothorax on haemodynamics in pigs. Med J Chin PLA 2024;49(8):897-904 (abstract read: right-sided tension compromises haemodynamics at ~3 mmHg pleural pressure, left-sided at ~8 mmHg) |
| `sheep_ptx_ppv` | cited in code/tests | Pneumothorax during positive-pressure mechanical ventilation in five anaesthetised sheep, J Thorac Cardiovasc Surg (abstract read: cardiac output falls steadily as the pneumothorax grows to 1000-1500 mL, right intrapleural pressure rises more than left, PaO2 stays normal). Authors not captured |
| `swine_ptx_peep` | cited in code/tests | Hemodynamic and respiratory effects of PEEP during a pulmonary distress model in isoflurane-anesthetized swine, UFRGS (abstract read: tension pneumothorax of 5-10 mmHg lowers cardiac index and stroke volume, raises shunt, dead space, PaCO2 and CVP) |
| `kheirabadi2013` | cited in code/tests | Kheirabadi BS et al. Vented versus unvented chest seals for treatment of pneumothorax and prevention of tension pneumothorax in a swine model. J Trauma Acute Care Surg 2013;75:150-156 (ongoing air accumulation behind an unvented seal produced tension pneumothorax, hypoxaemia and possible respiratory arrest) |
| `das2015` | cited in code/tests | Frerk C et al. Difficult Airway Society 2015 guidelines for management of unanticipated difficult intubation in adults. Br J Anaesth 2015;115:827 (scalpel-bougie-tube: transverse stab through the cricothyroid membrane, rotate blade, bougie, lubricated 6.0 mm cuffed tube; impalpable landmarks: 8-10 cm vertical midline incision; narrow-bore cannula needs a high-pressure source; excerpt read) |
| `umek2020` | cited in code/tests | Umek N et al. Rescue oxygenation success by cannula or scalpel-bougie emergency front-of-neck access in an anaesthetised porcine model. PLoS ONE 2020;15(5):e0232510 (thick pretracheal tissue; rescue oxygenation 18% cannula vs 83% scalpel-bougie; device placement 73% vs 92%; median 108 vs 90 s; severe trauma 27% vs 75%) <https://pmc.ncbi.nlm.nih.gov/articles/PMC7197851> |
| `rees2019` | cited in code/tests | Rees KA et al. Time to oxygenation for cannula- and scalpel-based techniques for emergency front-of-neck access: a wet lab simulation using an ovine model. Anaesthesia (doi 10.1111/anae.14706; abstract read: in novices cannula failed once and scalpel-bougie 15 times within 240 s) |
| `aslani2012` | cited in code/tests | Aslani A et al. Accuracy of identification of the cricothyroid membrane in female subjects using palpation. Anesth Analg 2012;114:987 (clinician summary read: correct in 0/15 obese and 10/41 non-obese women with the head neutral) |
| `lavelle2021` | cited in code/tests | Lavelle A et al. Accuracy of cricothyroid membrane identification using ultrasound and palpation in obese obstetric patients. Int J Obstet Anesth 2021;48:103205 (abstract read: correct identification 71% with ultrasound vs 39% with landmark palpation); concordant with the 39% vs 71% palpation figures for obese vs non-obese women in labour (Desai/You-Ten) |

## Secondary (33)

Primary source not read in this project.

| id | use | citation |
|---|---|---|
| `ardsnet2000` | cited in code/tests | ARDS Network. Ventilation with lower tidal volumes. N Engl J Med 2000;342:1301 (PBW formulas via LITFL; female constant 45.5 per original) |
| `guyton_hall` | cited in code/tests | Guyton & Hall Textbook of Medical Physiology (body fluid compartments; venous return; Starling curve) |
| `magder2012` | cited in code/tests | Magder S. Bench-to-bedside review: an approach to hemodynamic monitoring - Guyton at the bedside. Crit Care 2012 (stressed volume ~30%, Pms ~ 8 mmHg) |
| `atls` | cited in code/tests | ACS ATLS hemorrhage classification (teaching table; used only as qualitative bands in tests) |
| `toscani2017` | cited in code/tests | Toscani L et al. What is the impact of the fluid challenge technique on diagnosis of fluid responsiveness? Crit Care 2017 (54-60% responders) |
| `hahn_review` | cited in code/tests | Hahn RG. Volume kinetics for infusion fluids. Anesthesiology 2010;113:470 |
| `sessler1993` | cited in code/tests | Sessler DI. Perianesthetic thermoregulation and heat balance in humans. FASEB J 1993;7:638 |
| `insler2006` | cited in code/tests | Insler SR, Sessler DI. Perioperative thermoregulation and temperature monitoring. Anesthesiol Clin 2006;24:823 |
| `kurz1995` | cited in code/tests | Kurz A, Sessler DI, Lenhardt R. Perioperative normothermia to reduce the incidence of surgical-wound infection. N Engl J Med 1996 / redistribution data 1995 |
| `farmery1996` | cited in code/tests | Farmery AD, Roe PG. A model to describe the rate of oxyhaemoglobin desaturation during apnoea. Br J Anaesth 1996;76:284 (abstract + secondary quotes: 502 s / 171 s to 85%) |
| `benumof1997` | background | Benumof JL, Dagg R, Benumof R. Critical hemoglobin desaturation will occur before return to an unparalyzed state following 1 mg/kg intravenous succinylcholine. Anesthesiology 1997;87:979 (second-hand figures) |
| `litfl_vol` | background | LITFL Part One: Volumes and capacities (FRC -20% supine, further -20% under GA; closing capacity) |
| `wikianesthesia_preox` | background | WikiAnesthesia: Preoxygenation (ETO2 0.9 endpoint; denitrogenation 3-5 min; head-up data) |
| `weingart2012` | cited in code/tests | Weingart SD, Levitan RM. Preoxygenation and prevention of desaturation during emergency airway management. Ann Emerg Med 2012;59:165 |
| `radford` | background | Radford EP. Ventilation standards for use in artificial respiration. J Appl Physiol 1955 (anatomic dead space ~ 2.2 mL/kg) - textbook value |
| `bouillon2003` | background | Bouillon T et al. Pharmacodynamic interaction between propofol and remifentanil regarding hypnosis, tolerance of laryngoscopy, bispectral index and EEG approximate entropy. Anesthesiology 2004;100:1353 / Bouillon 2003 ventilation model via editorial (remifentanil C50 0.92 ng/mL) |
| `emdocs_capno` | background | emDocs end-tidal capnography review (CPR thresholds 10/20 mmHg, ROSC rise >10 mmHg) |
| `akinci2014` | background | Akinci E et al. 2014 ETCO2 and ROSC cut-off 28 mmHg (via emDocs) |
| `opentiva` | cited in code/tests | opentiva open-source TCI library (fentanyl Shafer, ketamine Domino, midazolam Albrecht, etomidate Kaneda, rocuronium Wierda, dexmedetomidine Hannivoort) <https://github.com/opentiva/opentiva> |
| `pytci` | cited in code/tests | PyTCI open-source library (Marsh, Schnider, Eleveld, Minto implementations) <https://github.com/JMathiszig-Lee/PyTCI> |
| `label_succ` | cited in code/tests | Succinylcholine chloride injection professional label (dose 0.6 mg/kg avg, onset ~1 min, recovery 4-6 min) |
| `label_sugammadex` | cited in code/tests | Sugammadex label (Vss 11-14 L, CL 88 mL/min, t1/2 ~2 h) |
| `label_diprivan` | background | Diprivan (propofol) label dosing text (2-2.5 mg/kg induction healthy <55 y; 1-1.5 elderly/ASA III-IV) |
| `erc2025` | background | ERC Guidelines 2025 Adult ALS (mirror text; epinephrine after 3rd shock in shockable rhythms; ventilation 10/min) |
| `pocock2022` | cited in code/tests | Pocock H et al. Effectiveness of alternative shock strategies for out-of-hospital cardiac arrest: a systematic review. Resuscitation 2022 (150 J BTE terminates VF in 90%) |
| `dosevf` | background | Cheskes S et al. DOSE-VF. N Engl J Med 2022 (refractory VF: ROSC 26.5% std vs 35.4% vector change vs 46.4% DSED) |
| `acc_aha_acs` | cited in code/tests | ACC/AHA 2025 ACS guideline (aspirin, P2Y12, FMC-to-device targets) as summarised in the research notes |
| `heart_score` | background | HEART score components (WikEM) |
| `laan2016` | cited in code/tests | Systematic review / meta-analysis of chest-wall thickness and 5-cm needle failure by site (abstract read on a mirror page: mean CWT 42.8 mm 2nd ICS MCL, 39.9 mm MAL, 34.3 mm AAL; failure 38% / 31% / 13%). Attribution to Laan DV et al., Injury 2016 is from memory - confirm before citing |
| `jsom2024_ptx` | background | JSOM Winter 2024 tension pneumothorax review page (spontaneously breathing patients: respiratory compromise first; positive-pressure ventilated patients: earlier circulatory compromise) |
| `nap4` | cited in code/tests | Cook TM et al. Major complications of airway management in the UK: NAP4. Br J Anaesth 2011;106:617 (figures via a teaching slide deck and Umek 2020: 58 front-of-neck attempts; cannula technique by anaesthetists failed in ~63%, surgical technique rarely failed; serious airway morbidity more frequent in the obese) |
| `apsf_fona` | cited in code/tests | APSF summary of a randomised crossover manikin study with impalpable neck anatomy and bleeding, n=65 anaesthesiologists: scalpel-finger-cannula success 86% vs scalpel-finger-bougie 63% (success = access within 3 attempts or 3 min) |
| `airwayapp_fona` | background | Airway App registry as quoted in the Cric-Guide review (Dundee): scalpel-bougie was the commonest eFONA technique (45/99) with an 18% first-attempt failure rate |

## Unverified (4)

Design values. Review required.

| id | use | citation |
|---|---|---|
| `design` | cited in code/tests | Simulator design value chosen for plausibility or calibrated to a target in tests; see docs/VALIDATION.md |
| `textbook` | cited in code/tests | Standard physiology textbook value recalled without a source check in this project |
| `amsa` | cited in code/tests | VF amplitude/AMSA predicts shock success (Povoas/Weaver-type findings) - qualitative use only |
| `stiell2014` | background | Stiell IG et al. 2014 depth/rate registry data (recalled, not retrieved in this project) |

