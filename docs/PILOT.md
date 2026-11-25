# Pilot with residents

A small first run of the protocol in [VALIDITY_STUDY.md](VALIDITY_STUDY.md): 10-20 participants, two scored cases each, about 45 minutes a person. It answers practical questions before the full study: does the session run smoothly, do learners understand what to do, do the scores look sensible across experience levels, and what confuses people. It is too small to *prove* validity; report it as a pilot.

## 1. Before you start

**Ethics.** If the data will be analysed or published as research, ask your ethics committee or IRB first (educational research with adult volunteers is often exempt, but they decide). If it is only usability feedback for improving the app, say so to participants and do not publish the scores.

**Where to run it: not on the free Render plan.** The free plan has no persistent disk ([render.yaml](../render.yaml)): sessions are lost when the service sleeps after a few idle minutes or redeploys after a push. Choose one:

| Option | How | Good for |
|---|---|---|
| **A. A laptop in the room (recommended for a pilot)** | `npm start` on a laptop (Node 20 or later), participants open `http://<laptop-ip>:8080` on the same network, or play on the laptop itself. Set `API_TOKEN` and a `DATA_DIR` you will back up: `$env:API_TOKEN='a-long-random-string'; $env:DATA_DIR='C:\pilot-data'; npm start` | Free, data never leaves the room, no sleeping |
| **B. Render with a disk** | A paid Render plan with a persistent disk mounted at `/data` (see [DEPLOYMENT.md](DEPLOYMENT.md)) | Participants playing from their own computers |

Do not push to `main` during the pilot: with option B every push redeploys, and the study should use one frozen version anyway (note the commit, or `npm run build` and keep `dist/BUILD.json`).

**Pseudonyms.** Prepare a list: `N01, N02...` for students, `R01...` for residents, `E01...` for experienced doctors. Keep the list of who is who on paper, apart from the data. The letter keeps the group; the server hashes the pseudonym again in the export, so step 4 shows how to map it back.

## 2. Participants

| Group | Who | Pilot target |
|---|---|---|
| N - novice | Final-year medical students | 5-8 |
| R - resident | Anaesthesia / emergency residents, years 1-3 | 5-8 |
| E - experienced | Consultants, 5+ years in anaesthesia, ED or ICU | 2-4 (enough to see the ceiling) |

## 3. The session (about 45 minutes per participant)

| Step | Time | What happens |
|---|---|---|
| 1. Consent and pseudonym | 3 min | Information sheet, consent, give the pseudonym card |
| 2. Familiarisation | 10 min | **Physiology lab**, any level, Guided tab allowed. Not scored: tell them it is practice |
| 3. Case 1 | 15 min | See the order table below |
| 4. Self-assessment and debrief | 5 min | The app asks for a score estimate and ANTS ratings before showing the score |
| 5. Case 2 | 15 min | The other case |
| 6. Self-assessment and debrief | 5 min | As above |
| 7. Feedback | 5 min | Usability questionnaire and three open questions (below) |

**For both scored cases, check before they press "Start the case":**
1. Section **Resuscitation**, level **Expert** (no coach, no senior hints). The level is written in the export, so a mistake can be found, but the score is not comparable.
2. **Learner ID** = their pseudonym (field above "Start the case").
3. **Do not change the patient** (sex, body shape, age, height, weight). The export flags a changed patient (`patient_default = 0`).
4. **Team mode off**: the "Lead a team" box in Settings and in the pre-brief stays unticked (one variable less for a pilot).
5. **Do not open the Guided tab** during scored cases; guided steps are counted in the export (`guided_steps`).

**Case order (counterbalanced).** Alternate by pseudonym number:

| Pseudonym number | Case 1 | Case 2 |
|---|---|---|
| odd (01, 03...) | Witnessed VF in a monitored bed | Rapid-sequence induction, BMI 45 |
| even (02, 04...) | Rapid-sequence induction, BMI 45 | Witnessed VF in a monitored bed |

**What the facilitator does during a case:** nothing clinical. Answer only questions about the interface ("where is the defibrillator?"), and write down every such question with the time; those notes are the most useful result of a pilot.

**Feedback at the end.**
- The System Usability Scale (Brooke 1996): the standard 10 statements, rated 1-5; score 0-100, above about 68 is better than average.
- Three open questions: What was hardest to find or do? What felt unrealistic? Would you use it to train, and how?

## 4. After the sessions: get the data

Download the export (one row per submitted case) from the machine that ran the server:

```powershell
curl.exe -H "Authorization: Bearer <API_TOKEN>" -o pilot.csv http://localhost:8080/api/research/export
```

Each row has: `verified`, `score_pct`, each criterion (`crit_*`), key action times (`t_monitoring`, `t_ivAccess`, `t_oxygen`, `t_firstDrug`, `t_airwaySecured`, `t_cprStart`, `t_firstShock`, `t_firstLab`), the self-assessment (`self_pct`, `self_ants_*`), and what helped or changed: `level`, `senior_hints`, `guided_steps`, `patient_default`, and the patient's `sex`, `age`, `height_cm`, `weight_kg`, `bmi`.

**Map rows back to groups.** `learner_pid` is the pseudonym hashed with the server's `API_TOKEN` (so keep the same token for the whole pilot). To see which pseudonym is which, run with that token:

```powershell
node -e "const c=require('crypto');for(const g of ['N','R','E'])for(let i=1;i<=20;i++){const p=g+String(i).padStart(2,'0');console.log(c.createHash('sha256').update(process.argv[1]+'\u0000'+p).digest('hex').slice(0,12),p)}" "<API_TOKEN>"
```

**Keep a row only if:** `verified = 1`, `level = expert`, `patient_default = 1`, `senior_hints = 0`, `guided_steps = 0`, and the scenario is `witnessed_vf` or `obese_rsi` (the familiarisation rows have scenario `free`). Report how many rows were dropped and why.

## 5. What to look at

| Question | Look at | A good sign |
|---|---|---|
| Does the session run? | Facilitator notes, dropped rows | No crash, few interface questions after the first case |
| Do scores follow experience? | Median `score_pct` per group and case | E > R > N, with little overlap between E and N |
| Do the key times make sense? | `t_firstShock` in VF, `t_oxygen` and `t_airwaySecured` in RSI, per group | Experienced doctors faster |
| Do learners judge themselves well? | `self_pct` against `score_pct` | Expected: novices over-estimate |
| Is it usable? | SUS score; open answers | SUS above 68; recurring complaints become fixes |

With this sample, report medians and ranges, not p-values. Bring the recurring interface problems back here: they are the first fixes before the full study.
