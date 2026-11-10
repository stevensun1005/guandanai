# Window 3 plan (draft for review): opening play of danMCai, 2026-11-09 23:30 to 2026-11-10 11:30 Toronto

Status: design draft, not yet preregistered. All times are Toronto (US Eastern). Every number quoted from tonight's work is development or descriptive evidence, not acceptance, not a win-rate or strength claim. Nothing in this plan changes web champion 017 (v000855042, SHA-256 `462afc99…`) or the web default 9001 (danMCai-reason-v000855042).

Paths: WT = `/Users/stevensun/Desktop/guandanai/.claude/worktrees/pull-latest-version-59e42e`; RT = `/Users/stevensun/guandan-runtime.noindex`; W3 = `/private/tmp/claude-501/-Users-stevensun-Desktop-guandanai--claude-worktrees-pull-latest-version-59e42e/e9af2e2c-19a3-5afc-a05f-d6672622d541/scratchpad/w3design` (tonight's evidence files); run directory for this window = `RT/window3-20261109/`.

## 1. Purpose

The owner wants two things from this window: (i) the reasoning bot should take over earlier than 40 table cards, and (ii) even where it does not, the raw network must stop the three faults seen at human tables (heavy early bombing then weakness later; a joker on a middling single or pair; a hand left as scattered singles at the end), through training, not hand-written rules. Both must be judged by the whole-round result.

The window therefore does one thing with the 12 hours of training compute and three measurements around it:

- Train one network, 017w, that is champion 017 with zero-initialised extra inputs carrying exactly the information the champion provably lacks: the trick being followed (owner, type, rank, size, consecutive passes), its own hand structure (singles, pairs, triples, bombs, wilds, jokers, level cards, distinct ranks) and the hand-inference network's 162 per-card marginals for the three hidden hands. Loss stays MSE on final single-round points, nothing else.
- Measure how much of the round is lost before the 40-card hand-over (true-hand oracle bound), whether the early bomb is a loss against opponents that are not copies of 017 (Clint continuations on the same 803 positions), and whether a belief model covering 41-108 cards makes earlier search *eligible* (true-deal regression gate), so that "reasoning earlier" rests on a test that has already failed once for the current world model.
- Accept or reject 017w once, inside the deployed 9001 machinery, over 3,000 held-out paired single rounds against 017 seats.

## 2. What the evidence showed

Recorded games (W3/audit.md; 31 rounds, 4 tables, identities unverified):

- At the same 1,022 following positions where a bomb was legal, unassisted humans bombed 11.2 %, champion 017 would bomb 36.0 % (paired difference +24.9 points, round-cluster 95 % [+19.5, +30.2]); above 80 table cards 4.2 % vs 29.8 %; on a partner's trick 0.7 % vs 15.0 %. Joker on an opponent's single or pair of K or lower: 13.6 % vs 25.0 % [+1.1, +22.4], n = 88. 017 breaks hand structure more than humans (0.493 vs 0.321 extra plays per play; paired +0.082 [+0.025, +0.140]). Simulated 9001 self-play strands high singles and jokers late (joker still held at round end 20.8 % vs 4.2 % for humans; bomb still held at first-out 30.5 % vs 59.6 %).
- The only recorded round decided by our neural bot: every move equalled 017's top choice; 8 of 10 real decisions were above 40 cards (no search); champion top-1 minus top-2 gaps at the criticised moves were 0.003-0.076.

Encoding (W3/ledger.md §1, verified with `WT/ai/danMCai/workspace/w3design-encode-blindspot.mjs`): when the last log entry and the partner's last action are both passes, the 513 state features are identical for a free lead, for following a 3 and for following an A. This state is about 22 % of all decisions (39.8 % of decisions have both slots empty), and both bombs in the recorded bot round were such blind follows. The 53 public extras in `WT/web/src/ai/policy-features.mjs` (trick present, owner, type, value, size, consecutive passes, first-out team, hand-structure counts) already encode what is missing; 017 does not read them.

Bomb counterfactual (finished 22:23, `RT/window3-prep-20261109/bomb-counterfactual/REPORT.md`, 803 positions above 60 cards where 017's top move is a bomb, d = best non-bomb minus bomb, acting-team round points): P1 (017 continuations) -0.014 [-0.173, +0.146]; P2 (9001 continuations) -0.136 [-0.296, +0.025]; blind follows under P2 -0.333 [-0.627, -0.039]; pre-fixed verdict (iii) inconclusive. Against copies of itself with accurate late play, the early bomb is not worse, and in blind follows it is better. So whether early bombing "loses" depends on the opponent; a network trained and accepted against 017 seats cannot be rewarded for bombing less, and this plan does not pretend otherwise.

Search above 40 cards (W3/calibration.md, 320 positions, up to 128 belief-v1 worlds): the rollout estimate carries no information beyond the champion's own Q (joint coefficient 0.03 [-0.36, 0.46] vs 1.24 [0.69, 1.72] for the Q gap), is optimistic by +0.67 ± 0.05, and every deviation rule scores at or below zero on the true deal (41-60: net-2 at 64 worlds -0.142 ± 0.071 per decision). At 21-40 the same code has slope 1.03 [0.76, 1.30]. Belief v1 was trained on 21-80 cards; sampled worlds under-count the opponents' four-of-a-kind ranks (1.41 vs 1.79). Cost is affordable (64 worlds within 50 s in every band), value is not. MODEL_STUDY §70.5 agrees (-0.148 [-0.214, -0.081] at 41-60 in real play).

Network (W3/ledger.md §4): every result that added information at decision time was positive (solver +0.076, belief search +0.139, combined +0.237 [0.208, 0.266]); every attempt to push that into the 567-input network was zero or negative (residual +0.003, PIMC regression -0.064, distillation reproduces 7-13 % of deviations); 24 more hours of the same training gave +0.0055 [-0.047, +0.058]. Search-knob tuning against 017 seats is flat (16 worlds +0.008, top-10 +0.001, endgame from 24 +0.013).

Hand-over (W3/calibration.md): corr(Q, result) at 41-60 is 0.58, so about a third of the result variance is visible at the hand-over; true-hand search at 41-80 is +0.96 [0.86, 1.06] (MODEL_STUDY §69), the only headroom measure.

## 3. What changes in the direction, and why

1. Stop tuning the search and stop training the 567-input network longer. Both are exhausted against 017 seats.
2. Change the inputs, not the loss. The owner's three complaints are all decisions the current network cannot distinguish (blind follow, hand shape after the move, where the unseen cards sit). Giving it the trick state, the pass record, its own hand structure and the belief marginals is the one training change that can remove these faults without a rule; the result label stays the whole-round points. This is Plan 2's input specification run on Plan 3's proven continuous trainer, which already supports a 53-wide `extras` input end to end (`fast-actor.mjs`, `inference-worker.mjs`, `lib.mjs` shards, `learner.py` `ValueNetExtras`, `export_onnx_extras`): widening it to 215 is a parameter change in six files, not new machinery.
3. "Reasoning earlier" is gated by a calibration test, not by a play test. The current world model fails it; a belief model covering 41-108 cards is trained tonight and judged by the same test. A paired play check runs only if it passes, and only as a development check.
4. Measure "bad against whom" instead of assuming it: the same 803 bomb positions get Clint continuations.
5. Acceptance stays vs 017 seats, 3,000 pairs, once. The style rates (bomb, joker, singles) are reported on the human positions as diagnostics and are never gates. This is a known blind spot (see §8).

Objections from the critics and how they are resolved:

- "Stage 3 of Plan 1 is 2-3× over budget and contradicted by its own calibration": Plan 1's opening search is dropped. Earlier search is reduced to the belief v1b gate (S4) plus an optional dev check.
- "Plan 2's S1b rule passes the already-failed estimator": the gate everywhere is the joint coefficient with the Q gap (lower bound ≥ 0.5), not a marginal slope.
- "Plan 2's all-new generator and learner on the critical path": the continuous trainer is used instead; new code is limited to widening and one option in the search tool. Fallback with zero new model code exists (B53, §8).
- "Plan 3's 9001 pool share 0.15 is really 1 %": 9001 seats are not in tonight's pool. Search-in-the-loop self-play needs an actor variant and would be ≤ 2 % of rows; it is the first item of the long-term track. This objection stands.
- "lr 1e-5 may not move zero projections": projections get their own Adam parameter group at 1e-4 (trunk 1e-5).
- "Clint continuations 3,200 rounds take 6 h": cut to 400 positions (all 255 blind follows plus the first 145 visible-trick positions by stored index), P4 only, 800 Clint rounds, 3 workers, hard budget 3 h.
- "600-pair dev gates only resolve 0.09": they are used only as a damage stop (threshold -0.10 with interval below zero), never as evidence of gain.
- "Tactical compute triggers" (joker/bomb in top-6): none in this plan.
- "Exploration keyed to bomb decisions": none; exploration stays softmax(Q/0.02) everywhere.
- Seed collisions between Plans 1 and 3: one registry in §6.

## 4. Stages

Cores: the Mac has 10; window 2 ends 23:00. All CPU work runs under `nice -n 10`; the learner uses MPS. The trainer's memory guard (pause below 4 GiB available, resume at 5 GiB) stays on. No new compute starts after 10:55; all processes end by 11:15.

| id | what | hours | cores | kind |
|---|---|---|---|---|
| S0 | preregister, freeze, seeds, STOP, dashboard | 23:30-00:00 | 1 | setup |
| S1 | hand-over headroom (true-hand oracle) | 23:45-02:30 | 3 | dev, reported |
| S2 | engineering: 215-wide extras, search tool option, tests | 23:30-01:30 | 1 | build |
| S3 | train 017w on the continuous trainer | 01:30-09:00 | 4 samplers + learner (MPS + 1) | training, dev stops at 04:30 and 09:00 |
| S4 | belief v1b for 41-108 cards and the earlier-search gate | 00:00-05:15 (+ optional to 09:00) | 3, then 2 | dev gate |
| S5 | bomb counterfactual with Clint continuations (P4) | 00:30-03:30 | 3 | dev, descriptive |
| S6 | acceptance: 9001 on base 017w vs deployed 9001 | 09:15-10:15 | 7 | acceptance (the only one) |
| S7 | diagnostics on human positions and S6 rounds; write-up | 10:15-11:30 | 1 | descriptive |

### S0 Preregistration and freeze (23:30-00:00)

- Create `RT/window3-20261109/` with `protocol.json` (this document's stage rules, seed ranges, SHA-256 of champion 017, belief v1 `16d76783…`, the frozen checkout commit), `STOP`-guard conventions (§7) and `dashboard.json` (one card per stage below, plus a card per owner task; START/END appended to `stages.log`).
- Freeze a detached checkout of the reviewed commit under `RT/window3-20261109/src/`; every tool runs from it.
- Run the seed audit: `assertHeldOut` against belief ranges and a grep of `WT/ai`, `WT/web/src`, `WT/ai/research/evaluation` and `RT/*/meta.json|protocol.json` for every range in §6; the audit output is stored as `seed-audit.json`.
- Bomb-counterfactual branch (rule fixed in the brief): the report's verdict is (iii) inconclusive (P2 interval covers 0, half-width 0.161). Therefore: no stage rewards or penalises bombing, exploration is uniform softmax, and "fewer early bombs" is reported descriptively only (S7). Had P2 excluded zero on the negative side, S5 would have been enlarged instead of S1; had it excluded zero on the positive side, the S7 bomb rate would be reported without the human comparison. Neither applies.

### S1 Hand-over headroom (23:45-02:30, 3 workers, dev, reported not gated)

Question: how many points per round are lost above 40 cards, against 017 seats, by raw 017 compared with perfect-information play, and how much is still lost below 40.

- Tool: `WT/ai/danMCai/workspace/rollout2.mjs --truth=1` (the MODEL_STUDY §69 oracle: one true-deal rollout over champion top-6 + pass) combined with the deployed 9001 below 40 via `midgame-search.mjs` (the implementer joins them with a `--opening=truth` arm in `midgame-search.mjs`, see §8 item 6, or runs rollout2 with `--lo=41 --hi=108` plus the standard endgame arm; whichever exists by 23:45).
- 400 paired deals, focal seats 0/2 vs raw 017 seats, single round, no tribute, seeds 4310000000-4310000399. Arms: A = deployed 9001; B = oracle above 40, deployed 9001 at ≤ 40; C = oracle throughout.
- Outputs: B-A (points recoverable above 40 with perfect information; upper bound), C-B (remaining below 40), A vs raw 017 as a pairing check against the known +0.237. Per-pair SD about 0.9 → SE about 0.045.
- Cost estimate (unverified): oracle about 0.5 s per decision, 12 decisions per round above 40, about 20 s per pair per arm → 400 × 3 × 20 s / 3 workers ≈ 2.2 h. The summary uses the contiguous completed prefix; if fewer than 250 pairs complete by 02:30 the stage stops and reports the prefix.
- Use: none as a gate. It states how much of the opening is worth fixing against 017 seats and is re-reported for 017w from S6's rows (Q at the first ≤ 40 decision regressed on the result).

### S2 Engineering (23:30-01:30, build; details file by file in §8)

Deliverables, in order: (1) 215-wide extras through actor, shard, inference worker, learner and export, with the initial model `v000000000.onnx` = champion 017 wrapped with a zero 215×512 projection and a Node parity test (values equal 017 to 1e-5 on 200 positions); (2) `midgame-search.mjs --focal-raw-model=<onnx>` so the focal seats use 017w for raw decisions above `hi` while candidates, rollouts, solver and opponents stay on 017, plus `--mode=raw` for greedy checks; (3) `opening-counterfactual.mjs --continuation=clint --positions=<rows.jsonl> --select=blind-first:400`. Hard order: (1) by 01:15 or fallback B53 (§8); (2) by 03:30 (first needed at 04:30); (3) by 00:30 or S5 is dropped.

### S3 Training 017w (01:30-09:00, 4 fast samplers + learner on MPS)

Run `RT/window3-20261109/train/` on the continuous trainer with:

- `initial` = wrapped 017 (215 zero extras); `extrasMode: "public-belief"` (new; 53 public extras + 162 belief-v1 marginals computed from the mover's public view, one belief inference per decision shared across candidates); fallback `"public"` (53, existing code).
- `actorMix: { self: 0.6, league: 0.3, rule: 0.1 }`; league pre-pinned with 017 (the initial) and P0 (`WT/web/src/ai/model-catalog.json` id 001) if the pinned-member file format is confirmed; hourly snapshots, PFSP by loss rate as today; Clint never, human data never.
- `exploration: softmax 0.02` unchanged; whole matches from level 2 as today; `targetMatchWeight 0` (single-round points), `anchorWeight 0`.
- Learner: MPS, batch 2048, clip 1.0, capacity 2,000,000, replay ratio 4, trunk lr 1e-5, projection lr 1e-4 (new `extrasLearningRate`), learner seed 20261110, `actorSeedOffset` set to a fresh block (§6). Export every 600 s; the trainer's own SPRT gates run as usual but are recorded as development, not acceptance.
- Expected volume at the Mac window's measured 3.27 updates/s minus belief overhead: 60-85k updates, 35-50M rows. The 24 h Mac window with 331k updates on the old inputs gave +0.0055, so any gain tonight must come from the inputs; this is stated in the protocol.
- Damage stops (dev, 600 pairs each, greedy raw 017w vs raw 017, single round, seeds 4313000000-4313000599 at 04:30 and 4313001000-4313001599 at 09:00, via `midgame-search.mjs --mode=raw --focal-raw-model`): at 04:30, if the estimate is ≤ -0.10 with the 95 % interval below 0, restart from `v000000000` with the trunk frozen and projections at 1e-4 (fallback F, new `trunkFrozen` option) for the remaining time. At 09:00 the same rule decides whether S6 runs at all: if ≤ -0.10 with interval below 0, S6 is cancelled and the window is reported as negative. Any other reading at 09:00 proceeds to S6; a 600-pair estimate is never reported as a gain.
- 09:00: samplers stop, the learner exports the final `v<step>.onnx`, SHA-256 recorded, Node parity of the export checked, candidate name `017w-v<step>` (research id only).

### S4 Belief v1b for 41-108 cards and the earlier-search gate (00:00-05:15; optional dev check to 09:00)

- S4a data: `WT/ai/danMCai/belief/generate.mjs --band=41-108 --every=2 --seeds=4312000000..4312039999 --workers=3` (40,000 champion self-play rounds, ~40 min on 3 workers at the measured 6 rounds/s/process; rows expected about 1.5-2M).
- S4b train: `belief/train.py --device=mps --minutes=35` on the v1 recipe (hidden 512, lr 1e-3, batch 1024), validation by seed block (`--val-mod=10`). Runs 03:30-04:10 while the learner is on MPS; the learner is data-limited so the contention is accepted and logged.
- S4c gate (04:15-05:15, 2 workers): on the stored 320 calibration positions (`W3/calib/`), 64 belief-v1b worlds with the same common random numbers, score every alternative on the true deal and fit the §5d joint regression (true-deal difference on rollout estimate and champion Q gap, position bootstrap). Pass requires all of: at 41-60 the rollout coefficient's 95 % lower bound ≥ 0.5 and the intercept interval covers 0; log loss per unseen copy at 41-80 not worse than v1 by more than 0.01 (v1: 0.774 / 0.913); 81-108 log loss better than uniform by ≥ 0.05 (v1 gain 0.057 at 81-108 overall, 0.021 at 101-108). Descriptive extra: opponents' natural four-or-more-of-a-kind ranks in sampled worlds (v1 1.41 vs truth 1.79).
- Outcome: "eligible for a paired play test" or "not eligible"; no play claim either way. If eligible and at least 3 cores are idle from 05:15 (S1 and S5 finished), S4d runs a development check: 400 pairs, search at 41-60 with 64 v1b worlds, deviation at paired z ≥ 2, vs deployed 9001, seeds 4314000000-4314000399 (about 60 s per pair, 3 workers, ≤ 3.5 h, stops at 09:00 whatever the prefix). SE about 0.04; only an effect ≥ 0.1 would be visible; it is labelled development and cannot qualify as acceptance.

### S5 Bomb counterfactual with Clint continuations (00:30-03:30, 3 workers, dev, descriptive)

- Same stored positions as P1/P2 (`RT/window3-prep-20261109/bomb-counterfactual/rows.jsonl`), 400 selected by the fixed rule above; arm A bomb, arm B best non-bomb; acting team 9001 (deployed machinery), opponents Clint rules-v2 with the web brain and the reason-match-eval desktop budget; Clint is evaluation only. Expected 800 Clint rounds at about 100 rounds/h/worker (whole-match figure, unverified for partial rounds) ≈ 2.7 h.
- Primary (preregistered): d_P4 on blind follows (n = 255). Secondary: all 400, paired d_P4 - d_P2 on the same positions. Reported with the Clint brain-timeout share (21.5 % in whole matches flatters the bot; if above 30 % the stage is reported as unreliable).
- Readings, fixed now: (a) d_P4 > 0 with interval above 0 → the early bomb loses against an opponent that is not 017: opponent-dependent waste, the strongest argument for pool diversity; (b) interval below 0 → not reproduced against Clint either; (c) covers 0 → inconclusive. No gate depends on it.

### S6 Acceptance (09:15-10:15, 7 workers; the only acceptance)

- A = deployed 9001 (017 base, belief v1, unchanged budgets). B = the same machinery with `--focal-raw-model=017w-v<step>` for the focal seats' raw decisions above 40 cards; candidates, rollouts, endgame solver and belief worlds unchanged. Opponents raw 017 seats; single rounds; no tribute; 3,000 paired deals, seeds 4320000000-4320002999, focal seats 0/2 in both orders; frozen checkout; B minus A in signed round points per deal pair, 95 % deal-cluster interval.
- Cost: 6.67 s per pair measured for the deployed bot plus one belief and one 017w inference per raw decision → about 7-8 s per pair → 3,000 / 7 workers ≈ 55 min.
- Power: per-pair SD 0.79-0.81 → SE 0.015; 0.045 at 80 % power, 0.05 at about 90 %.
- Decision rule: interval above 0 → `017w-v<step>` registered as a research candidate with a new id (not web, not champion, not default); interval covers 0 → zero result, inputs kept for the multi-day track; interval below 0 → negative. If fallback F or B53 was used, the report says which network was tested.

### S7 Diagnostics and write-up (10:15-11:30, 1 core, descriptive, never gates)

- Replay 017w at the 1,458 unassisted human decisions (W3 audit scripts, private records read only, no identifiers in any output): bomb rate at the 1,022 bomb-legal follows (017 36.0 %, humans 11.2 %), joker on K-or-lower singles/pairs (25.0 % / 13.6 %), structure cost per play (0.493 / 0.321), agreement with the human move (44.7 %), and the optimal-move rate on the 115 solvable critical decisions (017 0.730, humans 0.852).
- From S6's rows for arm B: singles among cards left at round end, joker and bomb still held at first-out, first-bomb table-card median, against the SIM9001 baselines (1.60, 20.8 %, 30.5 %, 76).
- Hand-over re-measure: corr(017w Q, result) at the first ≤ 40 decision vs 0.58 for 017.
- Write-up 10:55-11:30: results for every stage with completed counts, the seed audit, SHA-256 of every model, and the "could not verify" list; the lead reviews before anything is committed.

## 5. Hand inference in this window

Belief v1 enters play as 162 input marginals of 017w (S3, S6), as the sampler of the unchanged 21-40 search and endgame solver (S1, S5, S6), and belief v1b is trained and gated for 41-108 cards (S4). The long-term track (§10) keeps both roles.

## 6. Seeds to reserve

Checked tonight: 43xx seeds are used only by the bomb counterfactual (4300000000-4300000837, `dealsScanned` 838). 42xx holds belief (4255121000-4255160999), distillation (4264011000…, 4288077000…) and the window-1/2 evaluations (4200…, 4209…-4213…, 4221…-4245…); 39xx holds the calibration self-play (3990000000-3990000299) and committed tribute ranges; the trainer's actor seeds are a separate namespace (`actorSeedOffset` within `TRAIN_SEED_SPAN`). No repository file, research document or `RT` metadata references 4310000000-4329999999. The implementer re-runs this audit in S0 (other machines' histories could not be checked from here).

| range | use |
|---|---|
| 4310000000-4310000399 | S1 oracle deals |
| 4312000000-4312039999 | S4a belief v1b data (validation by `--val-mod=10` inside the range) |
| 4313000000-4313000599, 4313001000-4313001599 | S3 damage stops |
| 4314000000-4314000399 | S4d optional dev play check |
| 4320000000-4320002999 | S6 acceptance (held out: never used for any development check) |
| learner seed 20261110; `actorSeedOffset` = a fresh value above the Mac window's final `nextSeed` (read from that run's `status.json` and recorded in `protocol.json`) | S3 |

S5 reuses the stored counterfactual positions (seeds 4300000000-4300000837) deliberately, for pairing with P1/P2.

## 7. STOP and deadline behaviour

- One global file `RT/window3-20261109/STOP`; each run also honours its own `STOP` (`opening-counterfactual.mjs`, the trainer `runPaths.stop`, `midgame-search.mjs --minutes`, `generate.mjs`). Every tool is launched with `--deadline` or `--minutes` so that it ends on its own: S1 02:30, S5 03:30, S4d 09:00, S3 samplers 09:00 (learner exports and exits), S6 10:15 hard (summary on the completed prefix if earlier), S7 10:55.
- 10:55: no new compute; 11:15 every process of this window has ended (`pgrep` check logged); 11:30 write-up finished. No extension, no automatic restart with a new deadline; a restart after a crash uses the remaining time only.
- Memory: the trainer's 4 GiB guard; other stages stop launching workers when `vm_stat` free + inactive falls below 6 GiB.
- Dashboard: `RT/window3-20261109/dashboard.json` rendered by `WT/ai/research/tools/window-dashboard.mjs` on its own port; only the dashboard process is restarted when cards change; START/END for each stage and each owner task in `stages.log`.
- Nothing is committed during the window except, after the lead's review, the protocol, the dashboard config and the evidence files under `WT/ai/research/evaluation/window3-20261109/`.

## 8. What is implemented first (file by file, tonight, in this order)

1. `WT/ai/danMCai/training/continuous/value_net.py`: `ValueNetExtras(weights, extra_width=53)`; `export_onnx_extras(weights, path, extra_weight, extra_width)` with the `extras` input shaped `['batch', extra_width]`. Add `ai/danMCai/training/continuous/wrap_initial.py` (10 lines) that writes `v000000000.onnx` from `champion.onnx` with a zero 215×512 projection and prints its SHA-256.
2. `WT/ai/danMCai/training/continuous/learner.py`: `extrasMode` in `(None, "public", "zero", "public-belief")`; width 215 for `public-belief`; `Replay(..., extra_features=width)`; the `extra_weight` loaded from the ONNX initializer; two Adam parameter groups (`learningRate` for `layers`, new `extrasLearningRate` default 1e-4 for `extra_weight`); new `trunkFrozen` (sets `requires_grad_(False)` on `layers`). Checkpoint format unchanged.
3. `WT/ai/danMCai/training/continuous/lib.mjs`: `extrasWidth(mode)` helper; `ShardWriter` validates `x.length === width` and packs by width (today hard-coded 53 at lines 266-271); `DEFAULT_CONFIG.learner.extrasLearningRate = 1e-4`, `beliefModel: null`.
4. `WT/ai/danMCai/training/continuous/inference-worker.mjs`: read the extras width from the session's input metadata instead of the constant 53 (lines 85-89).
5. `WT/ai/danMCai/training/continuous/fast-actor.mjs`: for `public-belief`, load `config.beliefModel` through `belief/sampler.mjs createBeliefModel`, compute the 162 marginals once per decision from `features.mjs publicView(game, seat)` (new export `beliefMarginals(model, view)` in `sampler.mjs`, returning the network's 3×54 probabilities), and append them to each candidate's 53 public extras. Record the belief SHA-256 in the shard manifest.
6. `WT/ai/danMCai/training/continuous/supervisor.mjs`: accept the new mode, require `config.beliefModel` for it, store its SHA-256 in `config.json`.
7. `WT/ai/danMCai/belief/midgame-search.mjs`: `--focal-raw-model=<onnx>` (focal seats' raw decisions above `hi` scored by this model through `web/src/ai/policy-inference.mjs` with `extraFeatures` = 215: 53 public via `encodePolicyExtrasBatch` plus 162 belief marginals appended per row; opponents, candidate generation, rollouts and solver keep `--champion`); `--mode=raw` (focal plays the raw model everywhere, no search); the model SHA-256 in `protocol.json` and per-pair rows. `web/src/ai/search/core.mjs` is not changed.
8. `WT/ai/danMCai/belief/opening-counterfactual.mjs`: `--continuation=clint` (opponents via `decideClintRule(ruleObservation(game, p), WEB_BRAIN)` exactly as `reason-match-eval.mjs --clint=web`, acting team 9001), `--positions=<rows.jsonl>` and `--select=blind-first:400`; timeouts counted per round.
9. Tests under `WT/ai/danMCai/tests/`: (a) wrapped initial equals 017 on 200 positions in Node to 1e-5; (b) shard round trip with 215 extras; (c) learner one-step smoke on CPU with a 215-wide shard; (d) `beliefMarginals` shape 162 and sums per seat equal that seat's unseen count; (e) `midgame-search --mode=raw` with `--focal-raw-model` = wrapped 017 reproduces the champion arm pair for pair; (f) dashboard config parses. `npm test`, `npm run format:check` and the touched Python tests must pass before the checkout is frozen.
10. `RT/window3-20261109/protocol.json`, `dashboard.json`, `stages.log`; copies for `WT/ai/research/evaluation/window3-20261109/` after review.

Fallback B53 if items 1-6 are not green by 01:15: run S3 with the existing `extrasMode: "public"` (53 extras, no code change beyond item 2's parameter groups), belief stays in play through the search below 40, and the report says the belief input was not trained tonight.

## 9. Risks and fallbacks

- S3 flat (most likely; every push of information into this network has been flat). The window still yields: the headroom bound (S1), the Clint reading (S5), the v1b gate (S4), and a clean statement that inputs plus 60-85k outcome updates do not move the opening against 017 seats, which sends the multi-day track to search-in-the-loop self-play rather than more of the same.
- S3 damages the trunk: fallback F (frozen trunk) at 04:30.
- Belief inference halves sampler throughput: accept down to 40k updates; below that at 04:30, switch to `public` mode for the remaining time and say so.
- MPS contention between S4b and the learner: S4b is 35 min and the learner is data-limited; if the learner's updates/s halves during S4b, S4b is paused and resumed after 09:00 (then S4c/S4d are dropped and v1b is only trained, not gated, tonight).
- Clint single rounds slower than 100/h or brain timeouts above 30 %: S5 reports the completed prefix and the timeout share; no claim.
- Engineering slips: order of sacrifice is S5, then S4d, then S1's C arm, never S6.
- Acceptance blind spot (stands): S6 is vs 017 seats, which do not punish an early bomb (P1 -0.014, P2 -0.136 favouring the bomb). A 017w that bombs less because humans would punish it can score zero; one that bombs more can score positive. S6 answers "does the new information improve the whole-round result against 017", and S5/S7 report the owner's complaint descriptively. Evidence against humans or mixed teams does not exist tonight.

## 10. Out of scope tonight

Web deployment of any new network or id; changing champion 017, default 9001, `defaultId`, the menu or the move coach; tribute rounds and whole-match evaluation; any Clint or human data in training; 9001 search seats in the training pool (actor variant not built); opening search in play beyond the gated S4d dev check; belief v2/v3 variants; GuanZero; the two unfinished window-2 checks (V-w32 +0.054 [-0.009, 0.117] at 598 pairs, V-eg28 +0.029 [-0.018, 0.076] at 362 pairs), which are reported from their 23:00 state and not extended.

## 11. Long-term direction (for the next windows, not tonight)

Stop training the 567-input network and stop tuning search knobs against 017 seats; both are exhausted. The play network's inputs become trick state, pass and play order, own-hand structure and belief output (tonight's 215 extras are the first step); its targets become the whole-round result under accurate late play, produced by search-in-the-loop self-play (seats that search below 40 and solve the endgame) so that opening Q answers "what happens if my side plays the rest well", the mechanism behind the owner's hand-over complaint. Belief becomes a joint sampler that preserves hidden-hand combination structure (four-of-a-kind, long sequences) over 21-108 cards, and every world model is admitted by the true-deal regression (coefficient near 1, intercept near 0) before any play test, so that the search band can move earlier on evidence. The opponent pool gains accurately playing late-game seats (9001, GuanZero exports) within the rules; Clint and private human positions stay a fixed evaluation panel (single rounds, whole matches with tribute, unassisted human positions as held-out diagnostics). Acceptance moves from "vs 017 single round" to that panel, and coaching advice is validated on the owner's unassisted play. Hand inference stays in every stage.

## 12. Could not verify tonight

1. Per-decision cost of the true-hand oracle (0.5 s guess), of Clint continuations from mid-opening positions (whole-match figure 100 rounds/h/worker), and of belief inference inside the samplers; idle-machine timings (all rates were measured at load average 19-27).
2. That `ValueNetExtras`, `export_onnx_extras`, the shard writer and the inference worker take a 215-wide projection without surprises beyond the lines named in §8 (read, not run).
3. The league pinned-member file format for pre-seeding 017 and P0; 012's local file location.
4. Seed histories on the Windows machine and other Macs; the audit covers this repository and `RT` only.
5. The final V-w32 and V-eg28 results (snapshots at 21:27).
6. Whether 60-85k outcome updates can move a 1.34M-parameter network at all; the window is built so that a zero is informative, but it remains a four-way confound (inputs, volume, label noise, nothing to gain vs 017).
7. Any effect against humans, human partners, mixed teams, tribute rounds or whole matches.
8. The 9001-seat pool share question was resolved by exclusion, not by measurement.
