# Validity study protocol

**Status:** draft protocol, not yet run. It needs ethics review before any data is collected.

**Purpose:** collect the evidence a school, a journal or an accreditation body asks for before trusting the simulator's scores for decisions about learners. The simulator is an education tool, not a medical device (see `INTENDED_USE.md`). This protocol is about **educational** validity: whether the scores mean what we claim.

## 1. Questions

1. **Relations to other variables.** Do the scores separate learners with different experience (novice, resident, expert)?
2. **Internal structure.** Are the scores reliable? This covers agreement with trained human raters and stability between two equivalent cases.
3. **Response process.** Does the score reflect what the learner did, not an artefact of the interface? This covers verification by replay and think-aloud pilots.
4. **Content.** Do the scenarios and criteria match current guidelines and practice? This is reviewed by an expert panel.
5. **Consequences.** If a pass mark is used, how many learners would be wrongly passed or failed?

The framework is the five sources of validity evidence of Messick, as applied to simulation by Cook and Hatala (2016).

## 2. Participants

| Group | Who | Target n |
| --- | --- | --- |
| Novice | Final-year medical students, no ICU or ED rotation yet | 21 |
| Intermediate | Residents in anaesthesia or emergency medicine, years 1-3 | 21 |
| Expert | Consultants or attending physicians with at least 5 years in anaesthesia, ED or ICU | 21 |

**Sample size.** Simulation construct-validity studies usually find large differences between novices and experts (Cohen's d of about 1). A one-way ANOVA across three groups, effect size f = 0.40, α = 0.05 and power 0.80, needs about 21 per group (63 in total). For two groups at d = 1.0, 17 per group would suffice.

## 3. Procedure

1. **Consent.** Participants consent and get a pseudonym, which is what they type in the "learner" field. No names, no clinical data.
2. **Familiarisation.** A 10-minute free-play case with the physiology lab and the guided tab. It is not scored.
3. **Two scored cases** in counterbalanced order, one cardiac arrest (`witnessed_vf` or `stemi_vf`) and one non-arrest (`obese_rsi` or `tension_ptx`). Team mode is on for half of each group, randomly assigned.
4. **Self-assessment** (estimated score and ANTS ratings), recorded by the app before the score is shown.
5. **Screen recording** of each case for the human raters.
6. **Retest.** A subgroup of 10 per group repeats a parallel case 1-2 weeks later.

## 4. Measures

**From the app:**
- the verified score and each criterion;
- key action times (monitor, IV access, oxygen, first drug, airway, CPR, first shock, first lab);
- closed-loop communication;
- the self-assessment.

All of these are downloaded with `GET /api/research/export` (needs `API_TOKEN`). The export holds one row per submitted session, with the learner replaced by a salted pseudonym.

**From humans:** two raters, blinded to the group and to the app's score, score each recording with:
- a published checklist for the case type (for example the AHA megacode checklist for arrests);
- the ANTS rating scale for non-technical skills.

## 5. Analysis

| Question | Analysis | Target |
| --- | --- | --- |
| Experience separates scores | One-way ANOVA (or Kruskal-Wallis), post-hoc novice vs expert; effect size | Expert > intermediate > novice, d ≥ 0.8 between novice and expert |
| App agrees with raters | Intraclass correlation (two-way random, absolute agreement) between app score and mean rater score | ICC ≥ 0.75 (Koo and Li 2016: good) |
| Raters agree with each other | ICC between the two raters | ≥ 0.75 |
| Stability | ICC between test and retest | ≥ 0.70 |
| Self-assessment | Correlation and Bland-Altman of self estimate vs score; per group | Expected: weak correlation, novices over-estimate (Davis 2006) |
| Team mode | Read-back errors caught vs accepted, by group | Experts catch more |
| Pass mark | Modified Angoff by 6-8 expert judges, checked against contrasting groups | Report pass rates and misclassification per group |

**Missing data:** a session that is not verified by replay is excluded and reported.

**Pre-registration:** register the analysis plan (for example on OSF) before recruitment starts.

## 6. Content review (before the study)

An expert panel of at least 3 clinicians from anaesthesia, emergency medicine and intensive care reviews:
- every scenario, against the cited guideline;
- every scoring criterion and its weight;
- the `UNVERIFIED` constants listed in `VALIDATION.md` that a scenario depends on.

Changes are recorded in `CLINICAL_REVIEW.md` with the reviewer's name and the date. The study uses a frozen engine version; `npm run build` records its sha256 in `dist/BUILD.json`.

## 7. Ethics and data

- Educational research with adult volunteers: submit to the local ethics committee or IRB, which may classify it as exempt.
- Data stored: pseudonym, scenario, event log, scores, self-assessment. There is no identifying or clinical data.
- The export hashes the pseudonym again with a server salt, so it cannot be traced back to the learner field.
- Participation and scores are kept apart from the participants' formal assessments.

## 8. Limitations to report

- Screen-based simulation measures decisions and their timing, not manual skill.
- Single centre, volunteers.
- The physiology is calibrated to published target bands (`VALIDATION.md`), but several constants are design values pending clinical review.

## References

- Cook DA, Hatala R. Validation of educational assessments: a primer for simulation and beyond. *Adv Simul* 2016;1:31.
- Downing SM. Validity: on meaningful interpretation of assessment data. *Med Educ* 2003;37:830.
- Koo TK, Li MY. A guideline of selecting and reporting intraclass correlation coefficients for reliability research. *J Chiropr Med* 2016;15:155.
- McGaghie WC, Issenberg SB, Barsuk JH, Wayne DB. A critical review of simulation-based mastery learning with translational outcomes. *Med Educ* 2014;48:375.
- Davis DA et al. Accuracy of physician self-assessment compared with observed measures of competence. *JAMA* 2006;296:1094.
- Fletcher G et al. Anaesthetists' Non-Technical Skills (ANTS). *Br J Anaesth* 2003;90:580.
