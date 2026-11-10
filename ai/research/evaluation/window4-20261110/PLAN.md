# Window 4 plan — 2026-11-10, 11:15 → 23:45 Toronto (美东)

Runtime folder `RT = /Users/stevensun/guandan-runtime.noindex/window4-20261110/` (protocol.json, stages.log, STOP, dashboard.json, src-c frozen checkout, inputs/, logs/, scripts/, one folder per stage). Written 09:50 Toronto while window 3's S6 is still running; nothing here was run, edited or committed. Design: Fable. Implementation and operation: Opus. Model split, rules and the window-3 facts below are binding on the implementer; numbers marked "to be read" are filled in by W0 from result files, never from this text.

## 1. Purpose

One question decides the window and is the only acceptance: **does the window-3 network 017w (v000083172, 215 extra inputs) help the deployed reasoning bot 9001 when the opponents are themselves 9001 seats** (M11's registered S6b), not the raw 017 seats that window 3's S6 used and the owner has judged far below human level. Around it, the window builds and measures what the next windows need and cannot be bought with less than 12 hours of compute:

1. the `--opponents=search` evaluation path (both teams reason) with a parity test — the yardstick for every future acceptance;
2. exploiter **E1** = best response to frozen 017 (whole-round reward only, no tactics, no human data) — the rule-compliant opponent that punishes 017's early bombs, and a second yardstick for 9001;
3. the belief track's admission test for reasoning earlier (41–60 cards): belief **v2a** trained with the v1 recipe (v1b's failure was a recipe failure), the true-deal regression gate on the stored positions, and calibration on the unassisted human positions;
4. the **search actor** (all four seats reason at 21–40, exact ≤ 20) with its throughput number and a small search-labelled corpus kept in blocks for window 5;
5. descriptive readings: 9001 and 9001+017w against the frozen GuanZero export (evaluation-only, owner decision 2026-11-10 08:10), human-position style diagnostics for 017w and E1, E1 against 9001 seats.

Whole-round result is the only objective anywhere. Intermediate signals (tempo, bombs kept, tricks won) never enter a reward, loss, gate or acceptance. No web, champion or default change comes out of this window.

## 2. Evidence with numbers (window 3, read 09:45 Toronto)

**S6, the window-3 acceptance (017w above 40 inside 9001, vs raw-017 seats, held-out seeds 4294500000+).** Started 09:05 with a 68-minute budget (hard end 10:13), 3 000 pairs planned, A on 3 workers / B on 4. At 09:45 (40 min in): A 799 pairs, B 1 039, common prefix 799; **B−A = −0.084, 95 % [−0.181, +0.014], paired-difference SD 1.405** (A mean +0.252, B mean +0.168 against raw 017). Pace under load 8.9 s/pair/worker (A), 9.1 (B); median single-pair time 6.1 s. Projection at 10:13: ≈ 1 380–1 400 common pairs, **SE ≈ 0.038, not the registered 0.015** (3 000 pairs would have needed 2.6 h on 7 workers; the queue's slot was 68 min). The queue writes `S6/compare.json` at 10:15; the preregistered reading (interval above 0 / covers 0 / below 0) is taken from that file on the common prefix, with the prefix count stated. With the mean near −0.09 and SE 0.038 the verdict sits on the boundary between "covers 0" and "below 0"; W0 copies the exact numbers into protocol.json and MODEL_STUDY §77. Window-3 S3-ds1/ds2 (raw 017w vs raw 017, 600 pairs each): −0.05 [−0.14, +0.04] at step 42 299, −0.09 [−0.19, +0.01] at the final 83 172 — the raw network lost ground monotonically in the window-3 recipe (fast 017-greedy labels, self 0.6 / league 0.3 / rule 0.1, 2.31 updates/s on MPS).

**S1 hand-over headroom (400 development pairs vs raw-017 seats):** deployed 9001 vs raw 017 +0.281 [0.205, 0.357] (SD 0.78 single arm); perfect information above 40 minus 9001 +1.59 [1.46, 1.71]; perfect information everywhere minus that +0.75 [0.65, 0.85]. Upper bounds (they see hidden hands); most headroom is above 40 cards. Hand-over corr(Q, result) 0.67. Cost 9.26 s/pair/worker with only the focal team searching (≈ 10.4 searched decisions/pair at 0.52 s plus ≈ 5.5 exact endgame decisions at 0.62 s).

**S4 belief v1b (41–108 cards, 0.95 M rows, 35 min MPS, lr 1e-3, 74 epochs, no dropout):** failed the gate — rollout coefficient at 41–60 0.19 [−0.38, 0.70] (needs lower bound ≥ 0.5), log loss worse than v1 by 0.225 (41–60) and 0.156 (61–80), gain over uniform at 81–108 only 0.006; it lost to uniform on its own validation. v1 (lr 3e-4, wd 0.01, dropout 0.3/0.1, 20 k steps, 11 epochs) gives 0.775 / 0.915 nats per unseen copy at 41–60 / 61–80 on self-play, and **0.936 vs uniform 1.030 on the 1 458 unassisted human positions** (self-play 0.793 vs 0.976): weaker on humans but still informative. The 41–60 blocker is the world sampler: 128-world rollout coefficient 0.03 [−0.36, 0.46] against 1.03 for the 21–40 control; sampled worlds hold 1.41 opponent four-of-a-kind ranks vs 1.79 true.

**S7a solver panel at 10× budget:** 3 of 31 rounds complete; 28 hit the V8 default ~4 GB heap at ≈ 200 s. Two overnight stages failed on environment errors not caught by tests (launchd zsh cannot list ~/Desktop; `/usr/bin/python3` without numpy). Hence the new rule in §6: every queued stage is smoke-run under launchd itself before it is queued, with explicit heap size and measured peak RSS; private inputs live in `RT/inputs/`.

**Style gaps vs unassisted humans at the same positions (MODEL_STUDY §75, descriptive):** early bombing 36.0 % vs 11.2 %, joker on ≤ K 25.0 % vs 13.6 %, structure cost 0.493 vs 0.321, uncovered multi-card leads 14.9 % vs 7.4 %. Opening-bomb counterfactual (§74) inconclusive, leaning toward the bomb under accurate late play against 017 opponents.

**GuanZero (evaluation-only from window 4, AGENTS.md 2026-11-10):** `bot-026.onnx` = guanzero-adp-io48-385979, **SHA-256 21300c36c7c273b43274a83fa70dc62ce85be0cc84decc6dda2080548e0096b1, verified at 09:47 on this Mac at `/Users/stevensun/guandan-runtime.noindex/budget50-work/web/dist/models/bot-026.onnx`** (6 346 014 bytes, catalog entry 026, Release web-model-026). That folder is on the owner's cleanup list, so W0 copies the file into `RT/inputs/` and re-verifies the SHA before anything is deleted. The later exports 427033 (76fe6c93…; 0.413 [0.376, 0.452] vs raw 017 in 500 whole matches, 35.2 % wins) and 468071 (1573232742…) are **not** on this Mac (only plan JSONs); GuanZero's io48 run ends 2026-11-11 10:00. GuanZero inference exists in JavaScript (`web/src/ai/policy-inference.mjs` + `history.mjs`, 513-feature state, 20-entry public history, `config.history = "guanzero-v1"`): the browser already plays it, so no Python stack is needed for an opponent seat.

**Machine:** 10 cores, 32 GB (at 09:45: 1.1 GB free, 9.2 GB inactive under window 3), 91 GB free disk. main HEAD 8c7cc72 (AGENTS GuanZero entry). Trainer actor-seed namespaces used so far (every run config on this Mac and in `ai/danMCai/runs`): 3 000 000–3 100 000 … 40 000 000–45 000 000 (window-3 S3), and 45 000 000–49 000 000 reserved by the never-started fallback config S3F; nothing above 49 000 000.

## 3. What changes and why (objections resolved)

| Point | Decision | Reason |
|---|---|---|
| Statistics | Paired-difference SD **1.41** everywhere (not 0.8/0.9). S6b SE: 2 000 pairs 0.032, 1 500 0.036, 1 200 0.041; 80 %-power MDE ≈ 2.8·SE = 0.09 / 0.10 / 0.11 | Measured on S6 (799 pairs); Plans 1 and 3 used a single-arm SD |
| S6b cost | Two arms × four searching seats: **≈ 18 s/pair/worker assumed, measured by the smoke before the pair count is fixed**; 2 000 pairs on 5 workers = 4.0 h | Plan 1's 2.5 h / 15:05 decision was impossible; the count is written into protocol.json at launch, not now |
| Single acceptance | **S6b only** (M11). E1's final check against raw 017 has a fixed registration rule but is development-class | Plan 2 demoted S6b; a best response beating its own target is not an acceptance claim |
| E1 initial network | **raw 017 (462afc99…), extrasMode none** | Clean best-response design; 017w is already −0.09 vs 017; keeps "does hand inference help" separate (belief enters via 9001 seats, V2a/G1 and the corpus) |
| 017w training | **Not continued in window 4** | Monotone drift in the window-3 recipe; a search actor yields ≈ 1/40 of the fast stream, so search-in-the-loop training cannot finish in 12 h — it gets its actor, its throughput and a corpus instead |
| Belief track | V2a (v1 recipe on existing data) + G1 admission gate + H1 human calibration **after E1 releases the MPS (20:30)**; no new belief data generation (Plan 3's D1, V2b/G2/H2, P1, SP dropped) | Belief inference is mandatory in every long-term plan; but two trainings on one MPS plus 5 S6b workers oversubscribed cores and RAM (window-3 learner fell to 1.4 upd/s under contention) |
| Joint/SIR sampler | **Not built this window**; G1 runs v2a-marginal vs v1 | Build budget (§8) is ≈ 2 h and B1 is the critical path; G1 first tells whether the recipe alone moves 41–60; the sampler is window 5's first build item with G1's numbers as its target |
| GuanZero | Optional **GZ** card, run only on the locally verified 385979 file via the JS path; the tool (B3) is built only after B1, the E1 config and the search actor are reviewed | The ONNX does exist locally (contrary to the critique's search); 427033/468071 do not — the GZ reading is tied to 385979's SHA and is not comparable with GuanZero's whole-match numbers |
| Parity tests | On **decision fields** (`points, order, plies, differs, differPlies, endgame*` and the new `opp*` counters), never bytes | Rows carry wall-clock timings |
| Seeds | Fresh sub-blocks inside 4290100000–4290999999, disjoint per stage (§7); actor namespace 50 000 000–55 000 000; audit before launch | Critique 7; S3F's reserved 45–49 M avoided |
| Preflight | Plan 3's spec adopted for every stage (§6) plus Plan 1's `smoke.json` and the memory rule | Both overnight failures were environment errors |
| Dashboard | A card for every stage and for every owner task (cleanup, this plan, write-up) | 2026-11-09 owner rule |

## 4. First decisions at 11:15 — exactly as M11 registered

Read `window3-20261109/S6/compare.json` (common-prefix n stated) and `S7/report.json` (if the 10:15–10:55 S7 ran; else "not computed").

- **S6 interval above 0** → the 017w line continues (M11 criterion 1 met). S6b still runs as the confirmation against 9001 seats; E1 and everything else unchanged.
- **S6 covers 0** → the track continues by M11 (stop needs S6 negative *and* S6b ≤ 0). S6b decides whether v000083172 is a research candidate under 9001 seats or is archived.
- **S6 below 0** → S6b is the decider: S6b interval above 0 → continue from v000083172 (research candidate, new id, not web/champion/default); S6b covers 0 or below 0 → **the v000083172 line and the window-3 recipe end** (archived with its evidence). The input *direction* itself continues by the owner's 23:00 decision — through the C1 corpus and a window-5 restart from 017 + zero-initialised extras on search-labelled data — not by continuing this network.
- The enlarged-panel criterion (optimal rate up ≥ 0.05 with style rates toward humans) is reported from S8 but cannot decide anything: the panel is 3 of 31 rounds at 10× budget plus the 115 §67 positions.

The M11 decision is logged in `stages.log` when S6b's summary exists (≈ 17:20), with S6's n, S6b's n and both intervals.

## 5. Stages (Toronto times; 10 cores, 4 GiB RAM reserve kept by the trainer; everything `nice -n 10`; every job polls `RT/STOP` and its own `RT/<stage>/STOP`, every tool gets `--minutes`/`--deadline`)

| Id | What | Why | Time | Cores | Inputs | Outputs | Fixed rule | Class |
|---|---|---|---|---|---|---|---|---|
| **W0** | Close window 3 (S6 compare on the common prefix, S7 report), §4 decision text into protocol.json v1 with every SHA (017, 017w, belief v1, bot-026, src-c commit), freeze `src-c` at main HEAD (8c7cc72 or later), copy `bot-026.onnx` and the private human records into `RT/inputs/` (SHA re-verified, chmod 700), seed audit (§7), dashboard on port 8770 (restart only the dashboard process), launchd plists for every stage with `--smoke` | Register before computing; private inputs off ~/Desktop | 11:15–11:45 | 1 | window-3 result files | protocol.json, seed-audit.json, dashboard.json, inputs/ | — | audit |
| **T-cleanup** | Owner task: after 11:15 `git worktree remove` the ended runtime copies (`dashboard-runtime-*` except 8768/8769, `window2-*-runtime-*`, `reason-vs-clint-runtime-*`, old `.claude/worktrees`), **after** W0 has copied bot-026; windows 1–3 data kept | Owner asked; disk | 11:45–12:15 | 0 | — | stages.log lines with freed GB | — | owner task |
| **B1** | `--opponents=champion|search` in `midgame-search.mjs` (§8) + parity test + smoke measuring s/pair with four searching seats | Yardstick for S6b and every later acceptance | 11:15–13:15 | 0–2 (smoke) | src-c | commit on main, `B1/parity.json`, `S6b/smoke.json` | parity exact on decision fields or S6b is SKIPPED | build |
| **B2** | E1 config + 50-lineup assertion (self 0, every opponent = pinned 017, nothing else ever sampled) + trainer smoke (1 shard, 100 learner steps on MPS, peak RSS) | E1 must be a pure best response | 11:15–12:00 | 1 | src-c, 017 | `E1-config.json`, `E1/smoke.json` | assertion passes or E1 does not start | build |
| **E1** | Exploiter: continuous trainer from raw 017, extrasMode none, actorMix self 0 / league 1.0 / rule 0, league = pinned 017 only (leagueSize 1, researchSnapshots false, researchNoGate true), whole-round MSE, lr 1e-5, batch 2048, replay 4, 4 fast actors + MPS learner, hourly snapshots, diskLimit 12 GB | Rule-compliant opponent that punishes early bombs; second yardstick | 12:00–20:30 | 5 (4 actors + learner) | 017, E1-config | `E1/train/` exports v000…; final export SHA in stages.log | none (training) | development |
| **E1-ds1** | 600 pairs raw E1 snapshot vs raw 017, 1 worker, ≈ 1 min | Config-fault check | 16:00 | 1 | E1 latest | `E1/ds1.json` | mean > 0 expected; **if the interval is not above 0** → config fault: stop E1, log the fault, fix, restart from raw 017 once; if the 18:00 repeat also fails → E1 dropped, its cores go to S6b-ext | development |
| **E1-ds2** | same, 600 pairs | Progress | 19:00 | 1 | E1 latest | `E1/ds2.json` | none (reported) | development |
| **S6b** | **THE ACCEPTANCE.** A = deployed 9001 (champion 017 above 40, belief-world search 21–40 8 worlds k 6 net 2, exact PIMC ≤ 20), B = same with `--focal-raw-model=017w v000083172` above 40; **both arms `--opponents=search`** (opponent seats = deployed 9001); single rounds, no tribute, both seat orders; 2 000 held-out pairs (count fixed at launch from the smoke: > 25 s/pair/worker → 1 500, SE 0.036; stated) | M11's registered test | 13:15–17:15 | 5 workers | src-c, 017, 017w, belief v1 | `S6b/A`, `S6b/B`, `S6b/compare.json` | **B−A interval above 0 → 017w registered as research candidate under 9001 seats (new id; not web, champion or default); covers 0 → zero; below 0 → negative.** SE ≈ 0.032 at 2 000 pairs (SD 1.41), MDE ≈ 0.09 | **acceptance** |
| **M11** | Log the decision of §4 | Registered decision point | ≈ 17:20 | 0 | S6, S6b | stages.log, protocol.json addendum | as §4 | decision |
| **B4** | Search actor (§8): all four seats search 21–40 (belief-v1 worlds, 8-world, net-2) and exact ≤ 20; above 40 raw 017 with window-3 exploration (softmax 0.02); writes trainer shards with the 215 public-belief extras for above-40 decisions, whole-round label; launchd smoke = one full round under `/usr/bin/time -l` | Window 5's search-in-the-loop needs its actor and its cost | 13:30–16:30 | 0–1 | src-c | commit on main, `A1/smoke.json` | smoke rc 0 or A1/C1 SKIPPED | build |
| **A1** | Search-actor throughput: rounds/h, above-40 rows/h, searched decisions/round, peak RSS, vs the fast actor on the same deals | Sizes window 5 | 17:20–17:50 | 2 | B4 | `A1/throughput.json` | none | descriptive |
| **C1** | Corpus generation with the search actor, deal seeds 4290200000+, blocks of 100 rounds, finished blocks kept on STOP; ≤ 3 GB | Window-5 training data that 12 h cannot train on | 17:50–23:00 | 3 (2 while D1 runs) | B4, belief v1 | `C1/blocks/*`, `C1/manifest.json` (rows, rounds, SHA per block) | none | descriptive |
| **B3** | Optional: `--opponents=guanzero --opponent-model=<onnx>` using `web/src/ai/policy-inference.mjs` + `history.mjs` under onnxruntime-node; parity: GuanZero's choices identical on 50 stored positions to the web harness (`ai/guanzero/training/evaluate.mjs` path with the same session); 100-pair sign check vs raw 017 | Evaluation-only GuanZero card (owner 08:10) | only if B1, B2, B4 are reviewed by 16:30; else not built | 0–1 | src-c, inputs/bot-026.onnx | commit, `GZ/parity.json` | parity exact or GZ SKIPPED | build |
| **GZ** | 9001 vs GuanZero-385979 seats and 9001+017w vs GuanZero seats, 500 pairs each, same seeds (focal only searches, ≈ 9 s/pair) | First strength reading against a non-017-lineage opponent; not comparable with GuanZero's whole-match metric | 20:35–22:35 | 3 workers | B3, bot-026 (21300c36…) | `GZ/*.json` with the SHA | none; reported with intervals | descriptive |
| **E1-A** | E1 final export (raw) vs raw 017 seats, paired, 5 000 pairs, 6 workers, ≈ 10 min (raw SD ≈ 1.22 → SE 0.017) | Is E1 a usable opponent | 20:32–20:45 | 6 (brief oversubscription accepted) | E1 final | `E1/final-vs-017.json` | **registration rule, fixed now:** interval above 0 with lower bound ≥ +0.20 → E1 registered as research evaluation opponent (new id; not web, champion, default or teacher); above 0 but lower bound < 0.20 → "weak exploiter", archived; covers/below 0 → negative, the fine-tune recipe cannot beat its own target (archived) | development |
| **D1** | E1 final (raw, above 40 inside the 9001 machinery as in S6b arm B) vs 9001 seats, 1 000 pairs, 3 workers, ≈ 18 s/pair → ≈ 1.7 h | Exploitability of 9001 by a 017-best-response; usable-as-opponent check | 20:45–22:30 | 3 | E1 final, B1 | `D1/compare.json` | none; E1 kept as a window-5 opponent only if E1-A registered **and** D1 interval not below −0.30 (otherwise a 017-only exploit, archived) | descriptive |
| **V2a** | Belief v2a: v1 recipe exactly (lr 3e-4, wd 0.01, dropout 0.3/0.1, val-mod 10), max-steps 40 k, on existing data (window-1 H 5.0 M rows 21–80 + window-3 S4a 0.95 M rows 41–108, capped at 4 M rows in RAM ≈ 5.6 GB u8), then a 10-min structure head (natural-bomb count / longest-sequence class per hidden seat, targets from the stored y) | v1b failed on recipe; the question is whether the band is learnable | 20:35–21:30 | MPS + 1 | existing belief data (no new generation) | `V2a/model/belief-v2a.onnx` + SHA, `V2a/train.json` | none (val log loss by band vs v1 reported) | development |
| **G1** | Admission gate (S4c rule) on the stored 160 positions at 41–60, 64 worlds CRN, two lanes: v1 (re-run, control) and v2a-marginal; log loss on seeds 3990000000–3990000299 as S4c | True-deal regression is the admission test for reasoning at 41–60 | 21:30–22:30 | 2 | V2a, window-3 S4c inputs (copied to RT/inputs) | `G1/gate-v2a.json` | **eligible** iff rollout coefficient 95 % lower bound ≥ 0.5 and intercept covers 0 and log loss at 41–80 not worse than v1 by > 0.01; else not eligible. Descriptive: sampled bomb ranks vs 1.79 true | eligibility (not play) |
| **H1** | Belief v1 and v2a log loss per unseen copy on the 1 458 unassisted human positions vs uniform (S7-iii tool) | First v2a check on human play | 21:30–21:45 | 1 | inputs/human-raw, V2a | `H1/human-calibration.json` (no raw rows) | none | descriptive |
| **S8** | Human-position style diagnostics (S7 scorer, 1 458 / 269 / 115 positions + the 3-of-31 S7a rounds, said so) for 017w final (215 extras) and E1 final (zero extras): bomb-on-follow, joker ≤ K, structure cost, uncovered leads, solver optimal rate | The owner's four pattern gaps, measured | 22:35–23:00 | 1 | inputs/human-raw, scorer, models | `S8/report.json` | none; never a gate | descriptive |
| **T-plan** | Owner task: this plan (written 09:32–10:05) | 2026-11-09 rule | done | 0 | — | PLAN.md | — | owner task |
| **T-write-up** | MODEL_STUDY §77, `ai/research/evaluation/window4-20261110/*.json`, dashboard final, commit and push to main; **no new compute after 23:30**; `pgrep` clean by 23:40 | Evidence lands in main | 23:00–23:45 | 1 | all | commit SHA in stages.log | — | owner task |

Core load by period: 12:00–13:15 E1 5 + smokes; 13:15–17:15 E1 5 + S6b 5 = 10 (learner expected 1.5–2 upd/s, E1 ≈ 50–60 k updates, not 85 k); 17:15–20:30 E1 5 + A1 2 → C1 3; 20:30–23:00 V2a 1 + G1 2 + GZ 3 + D1 3 + C1 2 (E1-A's 6 workers for 10 min are a brief overlap, accepted). Memory: S6b workers 0.8–1.8 GB each (window-3 observed), trainer ≤ 6 GB with its 4 GiB reserve, V2a ≤ 5.6 GB only after E1 exits, solver lanes with explicit `--max-old-space-size=3072`.

## 6. launchd preflight (every stage, same plist, before the real command)

`scripts/<stage>.sh --smoke` runs **under the launchd job itself** (`launchctl kickstart`), never interactively, and writes `RT/<stage>/smoke.json` `{rc, peakRSS, seconds, node, python, onnxSHA}` plus a `SMOKE <stage> rc=<rc> rss=<MB> s=<seconds>` line in stages.log:

1. inputs listed by **node** from `RT/inputs/` (zsh under launchd cannot read ~/Desktop; nothing private is read from ~/Desktop);
2. `node --input-type=module -e "import('<tool>')"` for every tool the stage calls; `ai/danMCai/environment/mac/bin/python -c "import numpy, torch"` for every Python step; node and python paths recorded;
3. every ONNX the stage loads has the SHA-256 written in protocol.json (017, 017w, belief v1, bot-026, E1 snapshot) — mismatch = SKIP;
4. one full-budget unit under `/usr/bin/time -l` with explicit `--max-old-space-size`: one pair (S6b, GZ, D1, E1-A), one shard + 100 learner steps (E1), one round (A1/C1), one 64-world position (G1), one scorer run (S8, H1), 200 belief steps (V2a);
5. the stage starts only if rc = 0 and `peakRSS × workers + 4 GiB < free + inactive memory` at launch; otherwise `SKIP <stage> (smoke: <reason>)` — never a silent failure at 01:00.

## 7. Seeds (all < 2^32, fresh, audited by `scripts/seed_audit.py` extended with these ranges before any launch)

Known used: 4213xxxxxx (GuanZero), 4255121000–4255160999 (belief v1 training), 4291000000–4294502999 (window 3: S1, S4a, damage stops, S4d, S6), 3990000000–3990000299 (S4c log-loss validation, reused by G1 for the same purpose, stated), actor namespaces up to 49 000 000.

| Use | Range | n |
|---|---|---|
| S6b held-out pairs | 4290100000–4290101999 (reserve 4290102000–4290102999 for an S6b-ext) | 2 000 (+1 000) |
| E1-ds1 / E1-ds2 | 4290110000–4290110599 / 4290111000–4290111599 | 600 each |
| E1-A final vs 017 | 4290120000–4290124999 | 5 000 |
| D1 E1 vs 9001 seats | 4290130000–4290130999 | 1 000 |
| B3 GuanZero sign check | 4290140000–4290140099 | 100 |
| GZ two arms (same seeds) | 4290150000–4290150499 | 500 |
| C1 corpus deals | 4290200000–4290299999 (used in order, blocks of 100) | ≤ 100 000 |
| A1 throughput deals | 4290300000–4290300999 | ≤ 1 000 |
| B1 parity | window-3 S1 seeds 4291000000–4291000019 (already used; parity only, no evidence) | 20 |
| G1 | the stored 160 positions and S4c's world seeds (CRN) | — |
| E1 actor namespace | `actorSeedOffset` 50 000 000, `actorSeedEnd` 55 000 000 (nothing above 49 000 000 found; S3F's 45–49 M, never started, left alone) | — |
| Learner seeds | E1 20261111; V2a 20261112 | — |

World seeds inside the search derive as `(dealSeed·1009 + ply·7919) >>> 0` and wrap; harmless, stated.

## 8. Code to build first (≈ 2 hours of Opus, reviewed before anything depends on it)

1. **`ai/danMCai/belief/midgame-search.mjs`** — add `--opponents=champion|search` (default `champion`, byte-for-byte unchanged behaviour). With `search`, the opponent team's real decisions use the same machinery as the focal team (belief-v1 worlds, `worlds/k/net`, exact PIMC ≤ `endgameHi`), each seat on its own masked view with worlds seeded by the same `(dealSeed, ply)` rule; above `hi` the opponents play champion 017 greedy in **both** arms (they are the deployed 9001, never 017w). Rows gain `opp: {bandDecisions, searched, differs, endgameDecisions, endgameSearched, endgameFallbacks, searchMs, endgameMs}`; protocol records `opponents`. `--compare` unchanged.
2. **`ai/danMCai/tests/midgame-search-opponents.test.mjs`** — (a) `--opponents=champion` reproduces window-3 S1 arm-A rows on 20 pairs in every decision field (timings excluded); (b) swap identity: on the same seed, `--mode=champion --opponents=search` round r has the same played log and negated `points` as `--mode=search --opponents=champion` round 1−r (same seats search, same world seeds) with `--endgame=none` exactly, and with `--endgame=pimc` on points/order only (solver budgets are wall-clock); (c) `--opponents=search --mode=champion` with `--focal-raw-model` refused (opponents never take 017w).
3. **`RT/E1-config.json`** + **`scripts/e1-assert.mjs`** — config from §5; the assertion drives the actor's lineup sampler 50 times and fails unless every opponent is the pinned 017 member and no self or rule lineup appears; if `lib.mjs` rejects `self: 0` or the league auto-adds snapshots, the smallest change goes into `ai/danMCai/training/continuous/lib.mjs` with a unit test (`researchSnapshots:false` must add nothing to the league).
4. **`RT/scripts/preflight.sh`** — the §6 smoke harness shared by every plist (`com.guandanai.w4-<stage>`), writing smoke.json and the SMOKE line; **`RT/scripts/queue.sh`** — the time table of §5 with STOP checks, `run_bounded` deadlines and the S6b pair count read from `S6b/smoke.json` (≤ 25 s → 2 000, else 1 500), logged at START.
5. **`RT/dashboard.json`** for `ai/research/tools/window-dashboard.mjs` (port 8770): one card per row of §5 including the three owner tasks; S6b labelled 验收, G1 "资格判定，不作棋力验收", everything else "开发检查，不作验收" or 描述性.

Second block (13:30–16:30, after S6b and E1 are running):

6. **`ai/danMCai/training/continuous/search-actor.mjs`** — the search actor of B4, reusing midgame-search's decision functions (import, not copy), writing shards in the fast actor's format (`extrasMode public-belief`, 215 extras, whole-round label), deal seeds from a CLI range, block output, STOP-aware; **`ai/danMCai/tests/search-actor.test.mjs`** — one deal: the four seats' decisions equal midgame-search's on the same (seed, ply) worlds; shard layout equals the fast actor's on an above-40 decision.
7. Optional **B3** (`--opponents=guanzero --opponent-model=`): GuanZero seats through `web/src/ai/policy-inference.mjs` with the `guanzero-v1` history; parity test against the web harness's choices on 50 stored positions. Built only if items 1–6 are reviewed GREEN by 16:30.

Everything commits to main (training code and tools), never the runtime data; private inputs never leave `RT/inputs/`.

## 9. Disk, memory, STOP and deadline

- Disk: src-c 0.7 GB, E1 ≤ 12 GB (`diskLimitGB`, replay 2 M rows), C1 ≤ 3 GB, V2a < 0.2 GB, rows and JSON < 0.2 GB: **≤ 17 GB new**, under the 30 GB cap; windows 1–3 data untouched.
- Memory: trainer `resourceBudget {reserveGB 4, resumeGB 5}` as in window 3; smoke peak-RSS rule in §6; the solver lanes get explicit heaps.
- STOP: `RT/STOP` (global) and `RT/<stage>/STOP`; E1 exports on STOP, C1 keeps finished blocks, evaluations keep their prefix and summarise it with n.
- Deadline: global **23:45 Toronto (04:45Z 11-11)** in every plist and every `--deadline`; no new compute after 23:30; `pgrep -f guandan-runtime.noindex/window4` empty by 23:40. No extension, no automatic renewal.
- Window 3 is not touched before 11:15 (its queue ends at 10:55, processes exit by 11:15); nothing from window 4 starts compute before 11:45 except B1/B2 smokes (1–2 cores).

## 10. Risks and fallbacks

1. **`--opponents=search` cost.** 18 s/pair/worker is an estimate; the smoke measures it. > 25 s → 1 500 pairs (SE 0.036); B1 parity late → S6b may start until 14:30 with the count that ends by 18:30 (minimum 1 000 pairs, SE 0.044); later → **no acceptance this window, said plainly**, and the M11 decision is deferred to window 5's first stage.
2. **E1 drifts like 017w** (window-3 recipe minus self-play). E1-ds1 at 16:00 catches a config fault; one restart allowed; a second failure drops E1 and S6b-ext runs to 3 000 pairs on the freed cores (seeds 4290102000+).
3. **Core and MPS contention.** E1 shares 10 cores with S6b for four hours; expect 50–60 k updates. V2a never runs while E1's learner is on the MPS.
4. **Search actor late.** Only A1/C1 shrink; the acceptance never does.
5. **GuanZero path.** B3 is optional; if not built or parity fails, GZ is recorded "tool not built / parity failed", the file and its SHA stay in `RT/inputs/`.
6. **Belief gate.** G1 may say "not eligible" with v2a-marginal: then the blocker is confirmed to be the sampler (joint/SIR or autoregressive) and window 5 builds it; no play at 41–60 this window in any case.
7. **Heap.** Every solver lane and scorer run carries `--max-old-space-size`; the 28 unfinished S7a rounds are not retried this window (12 GB heap × lanes does not fit beside E1).

## 11. Out of scope

Continuing 017w's training; search-in-the-loop training; belief data generation; play acceptance at 41–60; a human-like opponent model (M12 stands: ~1 458 decisions from 4 tables); any web, champion, default, menu or evaluation-source change; Clint as a yardstick; GuanZero in any pool or as a teacher; whole-match (整场) evaluation; the S7a solver-panel retry.

## 12. Long-term direction (not authorised by this plan; for the record)

Window 5: the joint/SIR (or autoregressive) world sampler admitted by the true-deal regression; search-in-the-loop self-play restarted from 017 + zero extras on the C1 corpus (≥ 60 k rounds needed) with E1 and 9001 seats as the yardsticks; belief v2 with human-position calibration. Beyond: evaluation moves from 017 seats to a panel (9001 seats, E1, GuanZero evaluation-only, the human-position panels) and from single rounds toward whole matches once the per-round objective stabilises; human records keep accumulating as held-out panels and, past ~20 k unassisted decisions, as a possible human-like opponent — never as a second objective on the bot's own policy.

## 13. 给所有者的两段说明

**今天做什么。** 第三窗口的验收（017w 对 017 席位）09:45 时是 799 副、B−A −0.084 [−0.181, +0.014]，到 10:13 停时大约只有 1 400 副而不是 3 000 副，结果会落在"零"与"负"的边界上，报告按实际副数照实写。按 11-09 23:00 登记的 M11，今天唯一的验收换成 **对推理机器人 9001 席位** 的 2 000 副（13:15–17:15，五个核），先做"对手也会推理"的评测工具并通过一致性测试，再按实测每副耗时定副数。同时从 12:00 起训练一个只针对冻结 017 的"剥削者"E1（只用整局得分、不写规则、不用真人数据），16:00 做一次配置检查，20:30 结束后与 017 和 9001 席位各打一次；晚上用正确的配方重训猜牌网络 v2a，并用真实牌局回归判定它在 41–60 张能否"更早推理"，再在真人局面上算校准；下午搭好"四席都推理"的训练采样器，量它的吞吐并存一批小语料给第五窗口。GuanZero 385979 的权重本机确有一份（SHA 已核对，在您要清理的 budget50-work 里），11:45 前先复制到窗口目录再清理；它只作评测对手，工具建得完就跑 500 副，建不完就记"未跑"。

**今天不做什么、怎么判。** 不继续训 017w（它在第三窗口配方下一路退步），不动网页、冠军、默认和菜单，不拿 Clint 当标尺，不把 GuanZero 放进任何训练池。所有阶段先在 launchd 下自测一遍（输入可读、依赖可导入、量峰值内存）再排队，私有牌谱只放在运行目录里，避免昨晚的两次环境故障。结论只按预登记规则：9001 席位的 2 000 副区间在 0 以上，017w 才登记为研究候选（仍不是网页或冠军）；盖住 0 记零、低于 0 记负，与第三窗口的结果一起在 17:20 左右写下 M11 决定。若 S6 为负且今天也不为正，v000083172 这条线归档，但按您的决定，补输入、更早推理的方向继续，第五窗口从 017 加零初始化输入、用今天存的推理语料重启。截止 23:45 美东，23:30 后不开新计算，证据写入 MODEL_STUDY 第 77 节并推送。
