# Window 5 plan (final, revised after three reviews): 2026-11-10 23:50 → 2026-11-11 09:00 Toronto (美东)

RT5 = `/Users/stevensun/guandan-runtime.noindex/window5-20261111`, RT4 = `…/window4-20261110`. All times are Toronto (EST, UTC−5). Window-5 compute runs 23:50 → 08:40 (04:50Z → 13:40Z); the hard end is 09:00 (14:00Z). Opus agents build and run it. The design merges two plans, one critique and three reviews (feasibility, rules/goal, completeness), and §3 lists how each review defect was resolved. The pre-review draft is kept as `PLAN.draft-2105.md`.

State was read at 21:12 Toronto, read-only, with no running job touched:
- C1 had 78 finished blocks.
- GZ and S8 were still running.
- V2a had ended with rc 5.
- G1, H1 and D1 had not run.

## 1. Purpose

The owner's direction is binding:
- **Search first.**
- Networks are **trained on reasoning-bot play** (four-seat search data).
- **Borrow GuanZero's history-input structure.**
- Hand inference has a real role.
- No more "12-hour short fine-tune + acceptance vs 017" windows.

Window 5 does three things.

1. **Start the long-run network on reasoning play (L1, "017h").**
   - **Inputs.** It starts from 017 plus zero-initialised extras:
     - 53 public inputs;
     - 162 belief-v1 marginals;
     - **1,080 history inputs**. These use GuanZero's `history()` encoding of the last 20 public plays × 54. The encoding is **count-encoded** (0–2 per card, pass marker −1, int8), not one-hot.
   - **Target.** It regresses on the whole-round result of C2 rounds.
   - **What "reasoning play" means here.** In C2, every seat searches at 21–40 cards with belief-v1 worlds and solves exactly at ≤ 20. **Above 40 cards, the actions are raw 017 with softmax 0.02.** Rows above 40 therefore carry labels from rounds whose *continuation* is reasoning play. The actions at those rows are not reasoning play.
   - **Scope.** Tonight is **only the start** of that run. Continuing past this window needs **new owner authorization**, because the autonomous-compute authorization ends at 10:00 Toronto on 2026-11-11 (no new compute after 09:45).
   - **Measurement.** Tonight's L1 is measured only by held-out value error per band, on the same rows, against 017 and against a recalibrated 017 (§4 L1-mse). This is never a strength claim.
2. **Generate that data (C2).** The search-actor corpus is written in schema 2: `--rows=all` plus history and band sidecars. It uses belief-v1 worlds and produces as many rounds as the memory rule allows.
3. **Retry the belief model that window 4 could not train (V2a).**
   - Whenever v2a exists, reasoning at 21–60 is tested with **whole-round play**: D5 fault check, then ACC5 acceptance.
   - G1 (true-deal regression) and H1 (human calibration) are **descriptive diagnostics**. They do not decide whether the whole-round test runs, because AGENTS forbids intermediate signals as gates.

The only objective and the only label is the whole-round result: signed round points ±1..±3. The window adds no intermediate reward, no intermediate gate and no hand-written tactic. Web, champion, default and menu stay unchanged.

## 2. Evidence (read 21:05–21:12 Toronto, 11-10)

**Window 4 outcomes.**
- **The 017w line ended.**
  - S6: −0.103 [−0.179, −0.027] (1,322 pairs, vs raw-017 seats).
  - S6b: −0.096 [−0.150, −0.043] (2,000 pairs, vs 9001 seats).
  - M11 (21:46Z) archived the v000083172 line and the window-3 recipe. The input direction continues via C1 and a restart from 017 + zero extras.
- **E1 stopped.** It reached 12,253 updates at ≈ 0.8 upd/s beside S6b. E1-ds2 scored −0.116 [−0.206, −0.026] over 600 pairs. E1 is not used further, and D1 was skipped.
- **V2a did not train.** It exited rc 5 at 01:35Z.
  - Cause: free+inactive was 9,273 MiB beside C1/GZ, so the row cap was 1.94 M, below the 2 M rule.
  - Consequence: **G1 and H1 never ran**, and no v2a exists. V2a therefore runs first in window 5, and **alone**.
  - 4 M rows need free+inactive ≥ 12,058 MiB: 4 M × 1,416 B + 2.5 GiB working set + 4 GiB reserve.

**C1 corpus.** Search actor, `--rows=above`, 215 extras, belief-v1 worlds, deals 4290200000+.
- 78 finished blocks at 21:12, ≈ 4,170 rows/block, ≈ 6 MB/block.
- Peak RSS **2,293 MB/worker**, measured in done.json.
- Sustained ≈ **640 rounds/h/worker**; the latest block took 738 s.
- The actor deadline is 22:56, so expect ≈ 100–105 blocks (≈ 0.43 M rows, all above 40).
- **C1 has no history columns, and its public logs were not stored.** History cannot be rebuilt: wall-clock solver budgets make replay inexact.

**Throughput and machine facts.**
- **A1 throughput** was measured beside E1, so it is not an idle-machine figure. It ran 842 rounds/h/worker at 4.27 s/round, with peak 2,332 MB/worker.
- Per round, A1 produced 41.7 rows above 40, 10.2 band-searched decisions and 5.6 endgame-searched decisions. That is ≈ 57 rows/round with `--rows=all`.
- **Launchd smoke peaks are not real peaks.** C1 reported 126 MB and A1 409 MB, against ≈ 2.3 GB real (5–18× low).
- **Machine:** M1 Pro, 8 performance + 2 efficiency cores, 32 GB. At 21:08:
  - the compressor held 9.4 GB;
  - wired memory was 3.6 GB;
  - swap was 2.9/4 GB;
  - free+inactive was 9.8 GB.

**Earlier results.**
- **The only consistent positive is decision-time search:** 9001 scores +0.24 vs 017 seats.
- Distillation into the 567-input net was zero or negative. So were the short fine-tunes (017w, E1).
- The S1 upper bound for perfect information above 40 cards is +1.59.
- Belief v1 at 41–60 has a rollout coefficient of 0.03. v1b reached 0.19 and failed its gate.
- Sampled opponent four-of-a-kind ranks average 1.41, against 1.79 true. Marginal worlds under-produce bombs and long sequences.

**GuanZero.** It runs on the other machine, from scratch, with a 20-entry LSTM history on the same 513 encoder. Over ≈ 240 k steps (≈ 70 h) it went from 0.139 to 0.413 match score vs raw 017.
- Only its history *encoding code* is borrowed: `ai/guanzero/training/history.mjs`, with `history_reference.py` parity. Its SHA is pinned in protocol.json.
- **No GuanZero weights, labels, data or games enter danMCai training.** This is the evaluation-only rule.

**GZ and S8 were unfinished at read time.** Both are descriptive and change nothing here; W5-0 copies their final numbers.
- GZ: 9001 and 9001+017w vs GuanZero bot-026 `21300c36…` seats, deadline 22:35.
- S8: style diagnostics.
- The GuanZero label in protocol and reports follows `训练任务名-真实冻结版本`. It is resolved from the named export matching the full SHA, else the SHA prefix is used. It replaces "GuanZero-385979" from the window-4 notes.

**Code facts checked.**
- `learner.py` ingests only `run/shards/*.json`. Each data-file stem is the json filename minus `.json`.
  - It keeps a replay ring and **unlinks** `.x.i8 .y.f32 .e.f32 .json` of consumed shards once the newest rows exceed capacity.
  - It checks only `run/STOP`, and exports at the end only if step_count > 0.
- Extras widths are a registry (`value_net.EXTRA_WIDTHS = (53, 215)`). `trunkFrozen` and `extrasLearningRate` exist, and `wrap_initial.py --width` is generic.
- `search-actor.mjs --rows=all` exists. It names blocks `b000000…` per run directory, so slots collide.
- `midgame-search.mjs` takes a single `--belief` for every band.
- `history(state)` needs only `state.log` entries `{p, cards}`, and danMCai rounds keep `game.log`.
- The window-4 `common.sh` hard-codes 2026-11-10 and the 04:30Z/04:40Z/04:45Z deadlines.
- The window-4 `H1.sh` reads raw D1 snapshots.

## 3. Decisions taken from the reviews

**Kept from the draft:**
- V2a runs first and alone.
- C2 runs as independent one-worker slots with disjoint seed ranges.
- L1 runs on MPS after V2a exits, with the trunk frozen.
- Held-out-by-block per-band MSE is the main L1 measurement.
- STOP at 08:40; end at 09:00.
- GuanZero stays evaluation-only.
- C1 is not in L1.
- No L1 acceptance tonight.

Resolution of every review defect (F = feasibility, R = rules/goal, C = completeness):

| # | Defect | Resolution |
|---|---|---|
| F1 | `pgrep -f window4-20261110` matches the kept dashboard and queue.sh, so W5-0 never passes | W5-0 checks **compute processes only**: `pgrep -f 'window4-20261110.*(search-actor\|midgame-search\|python\|learner\|v2a_train\|g1_gate\|h1\.mjs)'` must be empty. `window-dashboard.mjs` (8770) is excluded and keeps running. A queue.sh still alive is logged; it can start nothing after 23:30. |
| F2 | Memory rule used smoke peaks; the OS figure left out the compressor and wired memory | The rule uses **registered measured peaks**: C2 2,300 MB/slot (C1 done.json); V2a 1.416 KB × rows + 2.5 GiB; L1 capacity × 2.53 KB + 1.5 GiB; midgame-search 2,300 MB/worker. Each is taken as max(smoke, registered) and compared with live free+inactive at each launch, minus 4 GiB. Realistic targets: 2 C2 slots beside V2a, ≈ 5 beside L1. **L1 capacity is 1.6 M rows.** |
| F3 | V2a takes ≈ 30–40 min, not 80; fixed clock times waste the machine | The schedule is **event-driven** (§4 timeline). L1, G1, H1 and extra C2 slots start at V2a END; D5 starts at H1 END; everything else follows END events. |
| F4 | Yield overstated | Restated at 640 rounds/h/slot over ≈ 35–40 slot-hours: ≈ 23–26 k rounds, 1.3–1.5 M rows, ≈ 4.7–5.3 k L1 updates. With D5/ACC5: ≈ 18 k rounds, ≈ 3.6 k updates. |
| F5 | ACC5 N ignored the worker split and B's cost | N = min(2000, floor(0.85 × ACC5 core-seconds available to 08:25 / (cA + cB))). cA and cB are D5's **core-seconds per pair** for each arm (wall × workers / pairs). Workers are split between the arms in proportion to cA:cB, so both arms reach N together. The verdict uses the common prefix. |
| F6 | Power misstated | Registered: per-pair SD 1.415 (S6 layout). SE is 0.071 at 400 pairs, 0.041 at 1,200 and 0.032 at 2,000. The 80 %-power detectable effects are ≈ 0.20, 0.115 and 0.089. **If N < 600, ACC5 does not run** (detectable effect > 0.16), and its cores go to C2. |
| F7 | Arm B changed two things at once (band and the belief at 21–40) | Build item 5 adds `midgame-search --belief-upper=<onnx>`, used only for searched positions above 40. B is then v1 at 21–40 and v2a at 41–60. If the item is not frozen by D5 start, B uses v2a in both bands and is **declared a combined arm** in protocol and reports. |
| F8 | L1-mse "signal" could be only policy-value calibration; zero history is a real input | (a) A **per-band affine-recalibrated 017** is the verdict comparator: a closed-form least-squares fit on the training blocks, CPU seconds. (b) Ablations **shuffle** the history (or belief) columns across rows within a band (seed 20261115) instead of zeroing them. (c) W5-0b measures 017's above-40 MSE, round-cluster SD and scorer rows/s on 20 C1 blocks. It registers the detectable Δ before L1 has data. |
| F9 | The build does not fit in 2 h 20 min | Two freezes, **src-e at 23:35** and **src-e2 at 01:45** (contents in §8). Each stage records its freeze and SHA and runs its own launchd smoke before launch. The fallbacks are independent (§8). |
| F10 | Copied scripts carry window-4 logic; learner unlink list; "one-hot" wording | V2a.sh: the E1/MPS wait and the `TEND` lines are rewritten to the window-5 deadlines, stated in protocol. The learner unlink list adds `.h.i8 .m.u8`. The wording is now "count-encoded". |
| R1 | Compute authorization ends 10:00 2026-11-11; "days 2–4" are not authorized | §1, §11, §12 and protocol state that days 2+ need new owner authorization. Saving the L1 learner and optimizer state is a precondition, not a plan. |
| R2 | G1 gating the only whole-round test is an intermediate-signal gate | G1 is **descriptive only**. D5 runs whenever v2a exists (trained on ≥ 2 M rows). The whole-round D5 fault rule and ACC5 decide; G1's numbers are reported beside them. |
| R3 | DEV-1 was a short fine-tune measured against 017 | **The DEV-1 pair match is dropped.** DEV-1 is now an inference-path parity check on 200 stored positions. First, zero-wrapped 1,295 017 must equal raw 017 in values and decisions. Then the final L1 export is reported as "% decisions ≠ 017" and value drift on the same positions. It is a fault check only; no sign or gain is reported. Seeds 4290520000–599 are released unused. |
| R4 | No champion verification of the actor's teacher | W5-0 verifies from current main: `web/src/ai/model-catalog.json` defaultId 017, `champion/champion.json`, the full accept record, the evidence SHA, and weight SHA `462afc99…` computed on the src-e copy. It writes these into protocol.json. **On any mismatch, nothing starts.** |
| R5 | Results not bound as AGENTS requires | The D5, ACC5, G1, H1 and L1-mse reports carry: W/L/T counts; rules (single round, `createRound`, no tribute, single-round metric); seeds; every model fingerprint (017, belief v1 `16d76783…`, v2a); encoder fingerprints (`web/src/ai/encoding.mjs`, `history.mjs`); src-e/e2 commits; data use (training / held-out / evaluation); uncertainty; and "not validated vs humans, human teammates, mixed teams or tribute". A positive ACC5 gets a new research-candidate id and changes no menu, default or champion. |
| R6 | Dashboard coverage incomplete | Owner-task cards go into the 8770 config **now**: T-window5-plan (open), T-review, T-build, T-smoke, T-docs, each with START/END in RT4 stages.log. They carry over to 8771, which adds cards for every §4 stage plus the feeder, L1-mse, M5 and T-writeup. C2 gets one `actor` card per slot. L1 uses `train` if the parse test shows it reads `learner.py`'s log; otherwise a new `learner` kind with its own parse test. The dashboard gets its own launchd smoke. |
| R7 | H1 read raw D1 snapshots (room numbers, nicknames) | A build step, `strip_human.mjs`, writes `RT5/inputs/human-research/`: room, nickname and seat-label fields nulled, `kind=test` rounds dropped, chmod 700, SHA in protocol. H1 reads **only** that copy. Its smoke checks the scorer still finds 1,458 unassisted positions. Output is aggregates only, and nothing leaves the machine. |
| R8 | Readings not frozen in advance; G1 seed reuse | protocol v1 freezes: the L1-mse bands, bootstrap and comparator; the exact export used for the verdict (final only; hourly exports descriptive); the D5/ACC5 rules; and the N formula. It states that 3990000000–299 is now used a third time for belief log loss (v1b, then v2a), which weakens that test. |
| R9 | Wording, naming and SHA pinning | Fixed in §1–§2. The SHAs of `history.mjs`, `history_reference.py` and `encoding.mjs` are pinned in protocol.json. |
| R10 | "Trained on reasoning-bot play" is overstated above 40 cards | Stated in §1 and §12. |
| C1 | Copied `common.sh` dates make V2a/G1/H1 exit at once | New `common.sh`: `tor()` covers 2026-11-10/11; NO_NEW_COMPUTE 13:40Z, PGREP_CLEAN 13:55Z, HARD_END 14:00Z. `grep -n '2026-11-10\|T04:' RT5/scripts/*` must be empty except inside `tor()`. Every smoke asserts its deadline is > 60 min ahead. |
| C2 | The v2a SHA cannot be in protocol at W5-0 | V2a.sh appends `REGISTER v2a sha256=… rows=… steps=… stopReason=…` to `RT5/protocol-addendum.jsonl`. Preflight accepts an ONNX SHA from protocol.json or the addendum. Only V2a.sh, at its registered SHA, may write that line. |
| C3 | Block names collide across slots, and dedupe loses rows silently | The feeder links data files as `s{slot}-{shard}.{x.i8,y.f32,e.f32,h.i8,m.u8}`. It **writes** (does not link) a rewritten `s{slot}-{shard}.json` whose name and shard match. A two-slot test gives both slots a `b000000`, and every row arrives. |
| C4 | Learner sees only `run/STOP`; no export if 0 steps ran | `L1.sh` runs a watcher that touches `L1/run/STOP` on `RT5/STOP`, on `L1/STOP`, or at `--max-seconds`. If no step has run by 08:30, L1-mse writes "no export; 017 and recalibrated-017 baseline only". |
| C5 | Learner I/O for schema 2 | The unlink list adds `.h.i8 .m.u8`. Tests: a schema-2 manifest is accepted; a schema-1 block is **rejected** in `public-belief-history` mode, so history is never zero-filled. |
| C6 | The y label is not tested | The item-1 test asserts that y on band-searched and endgame rows equals the mover team's signed whole-round points. |
| C7 | C2 waits on "training" and never starts if V2a fails early | C2 slots 0–1 start on "V2a logs training" **or** "V2a exited", whichever comes first, and at 00:00 at the latest. |
| C8 | Held-out set grows; scorer cost unmeasured | Hourly L1-mse readings are descriptive, on the held-out set as it stands then. The **final** reading re-scores 017, recalibrated 017, every export and both ablations on one held-out set frozen at 08:30. Rows/s comes from W5-0b. If the final run would exceed 9 min, it subsamples whole rounds (seed 20261114) and states the fraction. |
| C9 | ACC5 N rule ambiguous; lost partial blocks unlogged | N is defined in core-seconds (F5). Every C2 slot stop logs `PARTIAL slot=s rounds_lost=n`. |
| C10 | V2a may stop before 40 k steps | stopReason, steps, rows and step rate are recorded. If steps < 40 k, v2a is reported as "v1 recipe, truncated at n steps", and every G1/D5/ACC5 reading carries that qualifier. |
| C11 | Dashboard kinds unverified | Covered by R6; the dashboard config is in the build list and goes through the parse test. |
| C12 | MODEL_STUDY has no window-4 section | T-writeup, after 09:00, no compute: MODEL_STUDY §78 (window 4: S6b, E1, V2a rc 5, GZ, S8, the C1 archive, M11) and §79 (window 5). Written from a clean worktree; pushed only after `npm test`, `npm run format:check` and the related Python tests pass. |
| C13 | Node may resolve into the Desktop checkout under launchd | src-e/src-e2 copy `web/src/ai` and `ai/guanzero/training/history.mjs` with its imports. Each Node smoke asserts that `import.meta.resolve` of `history.mjs` and `encoding.mjs` lies under its src. The trainer venv path on ~/Desktop stays, as in window 4 where it worked; stated. |

**Deleted from tonight:**
- the SIR sampler and structure head (the first build item of the next authorized window; G1 reports the bomb and sequence statistics behind it);
- the `v.f32` auxiliary sidecar;
- the LSTM;
- trunk unfreezing;
- the DEV-1 pair match.

## 4. Stages

Every job:
- runs under `nice -n 10`;
- polls `RT5/STOP` and `RT5/<stage>/STOP`;
- carries `--deadline`/`--minutes` from the new `common.sh`;
- keeps a 4 GiB RAM reserve;
- starts only after its launchd smoke (§5) has passed and the memory rule (F2) holds at launch on live numbers.

| Id | What | Why | Start event (expected) | Cores | Outputs | Fixed rule | Class |
|---|---|---|---|---|---|---|---|
| **W5-0** | Compute-process check (F1); champion verification (R4); copy GZ/S8/C1 final numbers and SHAs into `protocol.json` v1 (src-e commit, every script SHA, `history.mjs`, `encoding.mjs`, 017 `462afc99…`, belief v1 `16d76783…`); seed audit (§6); strip-check of human-research (R7); dashboard on **8771** (8770 keeps window 4) | Register before computing | window-4 HARD_END (23:45) → 23:50 | 1 | protocol.json, seed-audit.json, dashboard.json | Audit and champion check must be clean, else nothing starts | audit |
| **W5-0b** | 017 above-40 MSE and round-cluster SD on 20 C1 blocks (chosen with seed 20261114); scorer rows/s | Registers L1-mse's detectable Δ and its cost (F8c, C8) | alongside V2a (≈ 23:52 → 00:05) | 1 | `L1/baseline-c1.json` (into protocol addendum) | none | descriptive |
| **V2a** | Belief v2a with the v1 recipe exactly: hidden 512, batch 1024, lr 3e-4, wd 0.01, dropout 0.3/0.1, suit augmentation, val-mod 10, 40 k steps, seed 20261112, `--minutes=55`. Data: window-3 S4a 41–108 first, then window-1 H and H-v2, ≤ 4 M rows. RT4 `V2a.sh` adapted (RT paths, deadlines, E1 wait removed). | The 41–60 question needs a model; window 4 could not fit it | 23:50 (END ≈ 00:30) | MPS + 1, alone with C2 slots 0–1 | `V2a/model/belief-v2a.onnx`, `V2a/train.json` (rows, steps, stopReason), addendum REGISTER | Memory rule: 4 M rows if they fit; 2–4 M → train with the cap stated; < 2 M → not trained, so D5, ACC5, G1-v2a and H1-v2a are SKIPPED and C2 gets +1 slot | development (val log loss by band vs v1) |
| **C2** | Search actor, schema 2: `--rows=all --history=1`; belief-v1 worlds at 21–40; exact PIMC at ≤ 20 (8 belief worlds); raw 017 above 40 with softmax 0.02 (as in C1); blocks of 100 rounds; `--max-gb=1.6` per slot (disk cap). **Slots** are independent `--workers=1` runs; slot *s* plays deals 4290400000 + 10,000·s … + 9,999 in order. | Training data for L1, and for later windows if authorized | Slots 0–1 at V2a "training" or V2a exit (≤ 00:00). More slots at V2a END, H1 END, G1 END, and whenever D5/ACC5 release cores, each subject to the memory rule. All slots stop at 08:35. | 2 → 3–4 → 4–6 | `C2/slot-s/blocks/*`; per-slot manifest (rows per band, SHA per block, rounds/h, PARTIAL lines) | none | data (descriptive) |
| **L1** | Learner "017h" (a run name only). Init: 017 wrapped with **1,295** zero extras (215 + 1,080 history); extrasMode `public-belief-history`; **trunk frozen**; extras lr 1e-4; Adam; batch 2,048; replay ratio 8; **capacity 1.6 M**; minSamples 100 k; targetMatchWeight 0; anchorWeight 0; seed 20261113. Exports hourly and at stop. `corpus-feed.py` (C3) feeds every finished C2 block with index mod 10 ≠ 9. STOP watcher (C4). | Learn whole-round values under reasoning continuation, with the inputs search uses implicitly (history, belief) | V2a END (≈ 00:30 → 08:30 `--max-seconds`) | MPS + 1 | `L1/exports/v*.onnx` + SHA; `L1/run/` (optimizer, log); `feed.jsonl` | none | development |
| **L1-mse** | Per-band MSE (> 40 / 21–40 / ≤ 20) against the whole-round label on held-out C2 blocks (mod 10 = 9). Scored: 017, per-band affine-recalibrated 017 (fit on the training blocks), and each export. The final export is also scored with history shuffled and with belief shuffled within band (seed 20261115). 95 % CI by round-cluster bootstrap, 2,000 resamples, seed 20261114. | Do reasoning-continuation data carry value information that 017 lacks, and do history and belief carry it? | Hourly after each export (≈ 5 min, descriptive); final on the frozen held-out set, 08:30–08:39 | 1 | `L1/mse.jsonl`, `L1/mse-final.json` (n rows and rounds per band) | **Read only at the final export, band > 40:** Δ = MSE(L1) − MSE(recalibrated 017). CI below 0 → "signal"; CI covers 0 → "no signal yet"; CI above 0 → "recipe fault". Δ vs raw 017 and the 21–40 / ≤ 20 bands are reported but not read. History carries information if MSE(history-shuffled) − MSE(L1) has its CI above 0; belief likewise. Not a strength measure. | development |
| **H1** | v1 and v2a log loss per unseen copy on the 1,458 unassisted human positions, vs uniform. Reads only `RT5/inputs/human-research` (R7). RT4 `H1.sh` adapted. | Human calibration of v2a | V2a END (≈ 00:30 → 00:50) | 1 | `H1/human-calibration.json` (aggregates only) | none | descriptive |
| **G1** | S4c true-deal regression on the 160 stored 41–60 positions × 64 worlds, CRN; lanes **v1 (control)** and **v2a-marginal**. Log loss on 3990000000–3990000299 (third use, stated, R8). Also reports sampled opponent bomb ranks (vs 1.79 true) and longest-sequence class match. | Explains *why* reasoning at 41–60 helps or not, and motivates the next sampler | V2a END (≈ 00:30 → 01:30) | 2 | `G1/gate-v2a.json` | None. Descriptive: the old eligibility thresholds are reported as numbers and not used. | descriptive |
| **D5** | Fault check, 400 pairs, deals 4290500000–4290500399. Opponents are raw-017 seats (`--opponents=champion`, the S6 layout, stated). B = 9001 reasoning at **21–60** (`--hi=60`, v1 at 21–40 plus `--belief-upper=v2a`, or the combined arm per F7). A = deployed 9001 (21–40, v1). Workers split by smoke pace. Measures cA and cB in core-seconds per pair. | Fault check before spending acceptance cores | At H1 END, if v2a exists and the D5 code is frozen. If `--belief-upper` is only in src-e2, wait until 01:50; if it is in neither freeze, run the combined arm from src-e. (Start ≈ 00:50–01:50; ends by start + 2 h.) | 3 | `D5/compare.json` (bound per R5) | ACC5 may run only if ≥ 200 pairs are done and the B−A mean is ≥ −0.20. Mean < −0.20 → ACC5 SKIPPED (fault). < 200 pairs by the time cap → ACC5 SKIPPED (pace). | development |
| **M5** | Decision record: D5 result, N from F5, worker split | Branch | D5 END | 0 | stages.log line + addendum | N < 600 → ACC5 SKIPPED, cores to C2 | decision |
| **ACC5** (conditional) | Same arms as D5, on held-out deals 4290510000+, with N from M5. At the end the common prefix is evaluated and its n stated. | Owner goal "reasoning starts earlier", tested on whole rounds | M5 (≈ 02:50 → 08:25) | 4 | `ACC5/compare.json` (bound per R5) | 95 % CI above 0 → "reasoning 21–60 with v2a" is registered as a **research search candidate** under a new id (not web, champion, default or menu). CI covers 0 → zero. CI below 0 → negative. Reported with power (F6) and with the C10 qualifier if it applies. | **ACCEPTANCE** (the only one; conditional) |
| **DEV-1** | Inference-path parity (R3). Zero-wrapped 1,295 017 vs raw 017 on 200 stored positions: values within 1e-5, decisions identical. Then the final L1 export on the same positions: % decisions ≠ 017 and mean \|value drift\|. | Fault check of the 1,295-wide Node path for later windows | 08:31–08:38 (needs src-e2 item 7) | 1 | `DEV1/parity.json` | If parity fails, record "inference path fault". No strength reading. | development |
| **T-close** | STOP everything at 08:40. Save the L1 final export and optimizer state. Write C2 manifests with the SHA of every block, END lines and the protocol addendum. Window-5 compute processes (`pgrep -f window5-20261111`) gone by 08:55. | Owner task | 08:40–09:00 | 1 | addendum, manifests | none | owner task |
| **T-writeup** | MODEL_STUDY §78 (window 4) and §79 (window 5), evaluation JSONs, CHANGELOG; clean worktree, tests, push to main (C12) | Owner task / AGENTS | after 09:00, no compute | 0 | main commit | none | owner task |

**Event timeline.** Times are expected; every start waits for its event, its smoke and the memory rule.

| Period | Running (cores) |
|---|---|
| 23:50–00:30 | V2a (1 + MPS), C2 (2), W5-0b (1, until 00:05) |
| 00:30–00:50 | L1 (1), G1 (2), H1 (1), C2 (3) |
| 00:50 or 01:50 → D5 END | L1 (1), G1 (2, until 01:30), D5 (3), C2 (3–4) |
| ACC5 phase | L1 (1), ACC5 (4), C2 (3–4), L1-mse (1, hourly) |
| No v2a, or ACC5 skipped | L1 (1), C2 (5–6), L1-mse (1, hourly) |

At most 9 cores are ever busy, and at most 8 of them with heavy jobs.

**Memory plan** (32 GB, of which ≈ 13 GB was compressor, wired memory and the owner's apps at 21:08):
- V2a phase: V2a ≤ 8.1 GB + C2 2 × 2.3 GB + 4 GiB reserve.
- Later: L1 ≈ 5.5 GB (1.6 M × 2.53 KB + 1.5 GiB) + C2 5 × 2.3 GB + 4 GiB.

The memory rule decides the actual count at each start. A target is never forced.

**Expected yield:**

| | Rounds | Rows | L1 updates by 08:30 |
|---|---|---|---|
| Without ACC5 | ≈ 23–26 k | ≈ 1.3–1.5 M (90 % training) | ≈ 4.7–5.3 k |
| With ACC5 | ≈ 18 k | (not estimated) | ≈ 3.6 k |

This is a start only. A first registered L1 acceptance needs ≥ 50 k updates, which is several days of corpus. That lies outside this window and needs new authorization.

## 5. launchd preflight (window-4 §6 procedure, with the review fixes)

`scripts/<stage>.sh --smoke` runs under the stage's own launchd job (`launchctl kickstart`), never interactively. It writes `RT5/<stage>/smoke.json` `{rc, peakRSS, seconds, node, python, onnxSHA, srcFreeze, deadlineAheadMin}`, and the line `SMOKE <stage> rc= rss= s=` in stages.log.

**Steps:**
1. Node lists inputs from `RT5/inputs` / `RT4/inputs`. Nothing is read from ~/Desktop under launchd except the trainer venv.
2. Every tool is imported, and `python -c "import numpy, torch"` runs with the trainer venv. `import.meta.resolve` of `history.mjs` and `encoding.mjs` must lie under the stage's src (C13).
3. Every ONNX SHA must equal protocol.json or the addendum (C2), else SKIP.
4. The deadline must be more than 60 min ahead (C1).
5. One full-budget unit runs under `/usr/bin/time -l` with an explicit `--max-old-space-size`:
   - **C2**: one round with `--history=1`; `h.i8` and `m.u8` exist with the right byte counts.
   - **L1**: a fed two-slot smoke (both slots `b000000`, all rows arrive); 100 learner steps on MPS with trunk bytes unchanged; one export; STOP-watcher behaviour.
   - **L1-mse**: the smoke block, with rows/s logged.
   - **V2a**: 200 CPU steps.
   - **G1**: one 64-world position.
   - **H1**: one scorer run on the stripped copy, finding 1,458 positions.
   - **D5/ACC5**: one pair with `--hi=60`, a v1 stand-in for v2a, and `--belief-upper` if frozen.
   - **DEV-1**: 20 positions with the 1,295-wide model.
   - **Dashboard**: one HTTP fetch with every card parsed.
6. Launch only if rc = 0 and `max(smoke peakRSS, registered peak) × workers + 4 GiB < free + inactive` at launch. Otherwise log `SKIP <stage> (smoke: reason)`.

**When smokes run:**
- src-e stages: 23:00–23:45, beside window 4, ≤ 1 core each, a few minutes each. Window-4 jobs are not touched.
- src-e2 stages: 01:45–02:15.

The memory rule is re-evaluated with live numbers at each real launch.

## 6. Seeds

All seeds are < 2^32 and fresh. `scripts/seed_audit.py` scans the window 1–4 protocols, run configs and `ai/danMCai/runs`, and its verdict must be "clean" before any launch.

**Used, and avoided:**
- 4213xxxxxx: GuanZero.
- 4255121000–4255160999: belief v1 training.
- 4290100000–4290300999: window 4 (S6b, E1-ds, E1-A, D1, B3, GZ, C1, A1).
- 4291000000–4294502999: window 3.
- 3990000000–3990000299: S4c / G1 log loss. Reused for the same purpose; this is the third use, stated.
- Actor namespaces ≤ 50,000,000.

| Use | Range | Count |
|---|---|---|
| C2 slot s (s = 0…9) | 4290400000 + 10,000·s … + 9,999 (4290400000–4290499999) | ≤ 10,000 per slot (≈ 4,500 expected) |
| D5 | 4290500000–4290500399 | 400 |
| ACC5 | 4290510000–4290511999 | ≤ 2,000 |
| DEV-1 | none: stored positions (4290520000–599 released unused) | — |
| G1 | stored 160 positions + S4c world seeds (CRN); 3990000000–3990000299 | — |
| Learner / statistics | V2a 20261112 (the same registered recipe, never trained in window 4); L1 20261113; L1-mse bootstrap and W5-0b block choice 20261114; ablation shuffle 20261115 | — |

World seeds inside search are `(dealSeed·1009 + ply·7919) >>> 0`; they wrap, which is harmless (stated). The L1 held-out split is by block (index mod 10 = 9 in every slot), so by deal, never by row.

## 7. Disk, STOP and the end

**Disk:**
- C2: ≈ 57 rows/round × 2,526 B (567 x + 860 e + 16 y + 1,080 h + 3 m) ≈ 144 KB/round, so ≈ 3.7 GB, capped at 9.6 GB by `--max-gb`.
- Feeder data links cost nothing; the rewritten json copies are a few KB each.
- L1 exports + optimizer < 0.2 GB; V2a < 0.2 GB.

Total **≤ 10 GB new**, against ≈ 81 GB free. C1 (≈ 0.6 GB) and windows 1–4 are untouched.

**STOP files:** `RT5/STOP` (global), `RT5/<stage>/STOP`, `RT5/C2/slot-s/STOP`, plus the L1 watcher that writes `L1/run/STOP`.
- C2 keeps its finished blocks and logs PARTIAL.
- L1 exports on STOP, or writes the zero-step note.
- Evaluations keep their prefix, with n stated.

**Deadline.** Every plist and `--deadline` comes from the new `common.sh`, and compute ends at **08:40 Toronto (13:40Z)**:

| Job | Ends by |
|---|---|
| ACC5 | 08:25 |
| L1 (`--max-seconds`) | 08:30 |
| C2 slots | 08:35 |
| L1-mse final, DEV-1 | 08:40 |

No new compute after 08:40. Window-5 compute processes are gone by 08:55, and the hard end is 09:00. There is no extension or renewal, and the 10:00 authorization limit is not used.

## 8. Code to build (Opus, from 21:15; commit to main; two freezes; in priority order, later items are dropped first)

### src-e (freezes at 23:35)

1. **`ai/danMCai/training/continuous/search-actor.mjs`**: add `--history=1`. The default 0 stays byte-identical to schema 1.
   - Per row, write `….h.i8`: 1,080 int8, the count-encoded `history(state)` from `ai/guanzero/training/history.mjs`, computed on the mover's public state **before** the action.
   - Per row, write `….m.u8`: 3 bytes. They hold the round index within the block; the band code (0 above hi, 1 band search, 2 endgame); and the number of cards on the table.
   - The shard json carries `schema 2, historyFeatures 1080, metaFeatures 3`, and done.json lists the SHAs.
   - **Test** `ai/danMCai/tests/search-actor-history.test.mjs`, on one deal:
     - x/y/e are identical to `--history=0`;
     - every h row equals `history()` recomputed from the round log at that ply;
     - band codes are consistent with cards vs lo/hi/endgameHi;
     - **y on band-searched and endgame rows equals the mover team's signed whole-round points** (C6);
     - 3 rows match `history_reference.py`.
2. **`value_net.py` / `learner.py`**: register width 1,295 and extrasMode `public-belief-history`.
   - In this mode the manifest must have `extraFeatures 215` and `historyFeatures 1080`; schema-1 blocks are rejected.
   - Replay stores e (float32, 215) and h (int8, 1,080) separately; each batch returns their float32 concatenation.
   - The unlink list adds `.h.i8 .m.u8`. Export goes through `export_onnx_extras` at width 1,295.
   - **Tests:**
     - `wrap_initial.py --width=1295` output equals 017 on 1,000 C1 rows with random history (max |diff| ≤ 1e-6, in torch and onnxruntime);
     - 20 learner steps with `trunkFrozen` change only `extra_weight`;
     - a schema-2 manifest is accepted and a schema-1 manifest is refused;
     - a 215-mode run is unchanged.
3. **`ai/danMCai/training/continuous/corpus-feed.py`** (new). Polls the slot directories every 60 s. For each finished block (done.json present, file sizes match):
   - if the block index mod 10 ≠ 9, hard-link the data files as `s{slot}-{shard}.*`, then write a rewritten `s{slot}-{shard}.json`;
   - if the block index mod 10 = 9, add it to the held-out list;
   - in both cases, append a line to `feed.jsonl`.

   It never writes or deletes the original files.
   - **Tests:**
     - a learner deletion of a fed shard leaves the block's files and SHAs intact;
     - two slots that both have `b000000` both arrive.
4. **RT5/scripts and dashboard for the src-e stages:**
   - **Shared:** `common.sh` (new dates, C1); `preflight.sh` (registered peaks, addendum, resolve check); `queue.sh` (event-driven); `seed_audit.py`; `make_protocol.py` (champion verification, R4).
   - **V2a:** `V2a.sh` (adapted, writes the addendum REGISTER) and `v2a_train.py` (copied).
   - **G1:** `G1.sh` and `g1_gate.py` (copied, descriptive wording).
   - **H1:** `strip_human.mjs`, `H1.sh` and `h1.mjs` (reading the stripped input).
   - **C2:** `C2.sh` (slot start/stop, memory rule, PARTIAL lines).
   - **L1:** `L1.sh` (config + wrap + feeder + STOP watcher + learner).
   - **Other:** `w5b.sh` and `close.sh`.
   - **Dashboard:** `dashboard.json` for `window-dashboard.mjs`, plus a new `learner` kind with its parse test if `train` does not fit.
   - **Now:** the owner-task cards in the 8770 config (R6).

### src-e2 (freezes at 01:45; each stage is smoke-tested before use)

5. **`ai/danMCai/belief/midgame-search.mjs --belief-upper=<onnx>`**: the belief net used for searched positions above 40 cards. It defaults to the `--belief` net, with byte-identical behaviour.
   - **Test:** with `--belief-upper` equal to `--belief`, results equal the current code on 20 pairs.
   - Ships with `D5.sh`, `ACC5.sh` and `m5.py` (N formula, worker split).
6. **`ai/danMCai/training/continuous/heldout-mse.py`** (new).
   - Scores per-band MSE for 017, recalibrated 017 and each export, plus the history and belief within-band shuffles.
   - Uses a round-cluster bootstrap and the frozen held-out list.
   - Subsamples only with the fraction stated.
   - Runs on CPU, 1 thread, and writes JSON with n rows and rounds per band.
   - Ships with `L1mse.sh`.
7. **`midgame-search` focal raw scorer** accepts 1,295-wide models (215 extras + `history(state)` as float). Ships with `DEV1.sh`.
   - **Test:** on 20 stored positions, a zero-wrapped 1,295 017 gives values and decisions identical to raw 017.
8. **Docs**, in the same commit set: CHANGELOG, plus the danMCai continuous/belief README lines for `--history`, `public-belief-history`, `corpus-feed.py`, `heldout-mse.py` and `--belief-upper`.

### Fallbacks (each independent)

| If this is late | Then |
|---|---|
| Item 1 | C2 runs schema 1 with `--rows=all`. |
| Item 1, 2 or 3 | L1 runs as **L1-215**: extrasMode `public-belief`, fed C1 and C2 blocks, same recipe, declared as the fallback. Its L1-mse verdict uses the same rule, without the history ablation. |
| Item 5 at D5 start | B runs as the declared combined arm (F7). |
| D5/ACC5 scripts by 01:45 | D5/ACC5 are SKIPPED. There is no acceptance tonight; v2a and the D5 readiness are recorded. |
| Item 6 | If it is frozen by 01:45, L1-mse runs as the final reading only. Otherwise no L1-mse reading is made tonight, and that is stated. |
| Item 7 | DEV-1 is SKIPPED. |

## 9. Risks

1. **V2a runs out of memory a second time.** Running alone after window 4 exits should leave ≈ 13–16 GB free+inactive, allowing for the compressor. The memory rule decides and logs; nothing fails silently.
2. **The corpus is smaller than projected.** Load, solver time with `--rows=all` plus history, and efficiency cores at ≈ 1/3 speed all cut yield. The result is fewer L1 updates. The reading stays the same and is stated with the actual counts.
3. **Overfitting at replay ratio 8 on a small corpus.** It shows as hourly held-out MSE falling and then rising. It is recorded, with no mid-run change.
4. **The learner deletes consumed shards.** Hard links on the same filesystem and the feeder tests guard against data loss.
5. **Inputs outside their tested range.** Belief v1 marginals at ≤ 20 cards lie outside v1's training range; they are used as computed, stated. `replay()` assumes 27-card starts and no tribute, which holds for `createRound` single rounds; the test pins it.
6. **ACC5 pace and power.** N is fixed from D5's core-seconds, and the common prefix is used at the end. The detectable effect is ≈ 0.09–0.12, so a smaller true gain reads as zero.
7. **The recalibration comparator is too strong or too weak.** Per-band affine recalibration is the registered comparator. The Δ vs raw 017 is reported beside it, and the two are never swapped after the fact.
8. **The owner's apps use varying memory** (browsers, Discord, ChatGPT). The launch rule absorbs this, and C2 is the elastic stage.
9. **The build is late.** The two freezes and the independent fallbacks (§8) keep V2a, C2 and L1 running even if every src-e2 item slips.

## 10. Out of scope

- Any acceptance of L1/017h tonight.
- Any short fine-tune acceptance or match against 017 (DEV-1 is a parity check only).
- Unfreezing the trunk.
- An LSTM history. Tonight's linear projection of the 20×54 counts is its simplest special case.
- The SIR / structure-head sampler.
- Auxiliary targets from search values. No such loss without owner approval.
- C1 in L1, unless the L1-215 fallback is taken.
- GuanZero in any pool, label or teacher role.
- Human records anywhere except H1, which uses the stripped copy and reports aggregates.
- Clint as a yardstick.
- Whole-match evaluation.
- Changes to web, champion, default, menu or evaluation source.
- Teacher refresh.
- Any compute after 08:40, or beyond the 10:00 authorization.

## 11. What decides the next run (any compute after 10:00 needs new owner authorization)

1. **L1-mse at the final export, band > 40, against recalibrated 017**, together with its shuffle ablations:

   | Reading | Next step to propose |
   |---|---|
   | Signal | Continue the same recipe on more corpus toward a first registered acceptance: ≥ 50 k updates, 017h above 40 inside 9001, vs 9001 seats, 2,000 held-out pairs. |
   | No signal | A registered change (trunk unfreeze at 1e-5, or an LSTM history), decided in daylight. |
   | Fault | Investigate before any more training. |

   History-shuffled vs full shows whether GuanZero's history structure carries information here. Belief-shuffled does the same for hand inference.
2. **D5/ACC5** (whole-round) against the deployed 9001, with v2a and with the F7 arm definition stated.
3. **G1** (descriptive): the v2a lane's coefficient, intercept, log loss, bomb ranks and sequence match. If ACC5 is zero or negative and G1 again shows missing bombs and sequences, the next build item is the SIR/structure sampler.
4. **C2 throughput** under load: rounds/h/slot, rows per band, bytes/round and searched-differs rate. These give the days needed to reach 300 k rounds, and show whether 5–6 slots plus the learner fit.
5. **H1**: v2a vs v1 on human positions. **DEV-1**: parity (fault check only).

## 12. 给所有者的两段说明

今晚第五窗口从 23:50 到明早 09:00，08:40 以后不再开始新的计算。按你定的方向，先让四家都用推理出牌的对局大量产出数据（C2），再用这些数据训练新网络 017h（L1）。要说明一点：40 张以上那一段仍由冠军 017 出牌，40 张及以下才开始推理，所以这部分数据是"后面由推理打完"的整局结果。新网络从 017 出发，额外接上三类输入：公开信息、手牌推断给出的对手各张牌概率，以及借自 GuanZero 的"最近 20 手出牌记录"（计数编码）。GuanZero 只借了编码方式，它的模型和对局都不用。新输入的权重从零开始，训练目标只有整局得分。按实测速度，今晚约产出 2.3–2.6 万局，网络更新约五千次（如果跑正式对比，约三千六百次）。所以今晚不做和 017 比胜率的验收，只在留出的牌局上比较预测误差，比较对象是"按分段校准过的 017"。另外会把出牌记录和推断概率分别打乱，看它们各自有没有贡献。授权只到明天 10:00，多天继续训练需要你另行批准；今晚会把模型和优化器状态完整保存，方便以后接着跑。

手牌推断今晚有三个实际用途：推理时抽样对手手牌；作为新网络的输入；重训一版推断模型 v2a（第四窗口因内存不够没跑成，今晚先单独跑）。按规则，中间指标不能当门槛，所以 v2a 的真实牌局回归检验（G1）和真人校准（H1）都只作描述。只要 v2a 训练成功，就直接用整局对局检验"把推理提前到 41–60 张"：先跑 400 对故障检查（D5），没有明显变差，再做一次正式对比（ACC5）。正式对比和部署中的 9001 比较，双方用同一批新牌，对手都是 017。41–60 张用 v2a，21–40 张仍用 v1；如果代码来不及完成，会明确标成"两项改动合并"。局数按实测速度确定，大约能检出 0.09–0.12 的差异。就算通过，也只登记为研究用的搜索候选，不改网页、默认、菜单或冠军。如果不通过，而 G1 又显示抽样漏掉了对手的炸弹和长顺子，下一步就改进抽样方法。真人牌谱只使用去掉房间号和昵称的副本，并且只做校准汇总。09:00 以后不再计算，只补写第四、第五窗口的研究报告并推送。
