# Window 3, S7: descriptive diagnostics of 017w

Written 2026-11-10 10:49 US Eastern (Toronto) by scripts/s7.sh and scripts/s7_report.py. **Descriptive only: every number below is labelled "descriptive, not a gate". None is an acceptance metric, a reward, a loss or a win rate.** Bombs, jokers, hand structure, leads and cover are intermediate signals (AGENTS.md whole-round rule). The only acceptance of this window is S6 (protocol v2), which this report cites but does not change. Private human records were read in place (trust `unverified_browser`); this report holds aggregates only, with no nickname, room, record id, match id or file name.

## Models and files

- Champion 017 (v000855042), SHA-256 `462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7`.
- 017w: research network `017w-v000083172` (step 83172), SHA-256 `f00e662206844b707b7efc0d1c729784754dd93c41a9ad2f173f40a80a62fec6`; from S3/final-export.txt (queue, after the 09:00 stop). Not web, not champion, not default.
- Belief v1, SHA-256 `16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9`.
- `S7/scorer.mjs`: `b6372ee7139807148005af43586091ea1da6534aa26d3b5b97cdf5a35f4a2071`
- `S7/arm-replay.mjs`: `b8b8eb2c7764f4aaf1f6307f43aeab82470d55b70eb8825e7a028a6d5cfbb1f2`
- `scripts/s7.sh`: `e6e838b42284547568546d192c23fcbe3f15588c171f057475438ca0fb63e8a9`
- `scripts/s7_report.py`: `4ed8b83ab23639b71eb5cbfaae27798ed9fbab1c9468e5a5a382bfbe68620c04`
- `S7/panel.json`: `82ba0d6a93ad512b8c663e5cdf3343be07f336c42eb3a25db019a1fc6b90a84a`
- `S7/parity.json`: `d99d04e6033353ea5f02397baff08d951d90987eb567aae53081ad5f56396249`
- `S7/arm-replay.json`: `bbe3a3ffa035018303abbfc3ace8d1547360697531bb691c3f58a8985289c344`
- `S6/compare.json`: `a750d9d87dff487c14948402dda58247e2f786bb416ea10092f7a50ef743c614`
- `S7a/summary.json`: `ed5ef8a3632b513b98a24f7e8cfbe46af52720af27ba6a1bb3ee270789b9c252`
- `human-panel.json`: `2daaf40d34e8a8187d5bfa79b7a73e963e6a35ba17b07f2b8bf3de8824d26008`

## Scorer acceptance (descriptive tool check, not a gate on 017w)

07:00 queue check with the wrapped initial `v000000000` (017 + zero 215 projection): choices identical to 017 at 1458 of 1458 human decisions, 269 of 269 lead positions, 115 of 115 solver positions; published 017 numbers reproduced: True; pass True.

## Human panel: 017w and 017 at the same positions (descriptive, not a gate)

Panel registered before any 017w existed (human-panel.json, M3): 1458 unassisted human real decisions in 31 rounds (31 of 31 record files match the registered hashes), 1022 bomb-legal follows, 88 joker opportunities, 269 lead positions, 115 section-67 critical decisions, 4 S7a critical decisions. 017 is scored exactly as the audit (championValues); 017w exactly as midgame-search.mjs focalRawDecision (53 public extras + 162 belief v1 marginals from the mover's public view). Reproduction of the frozen rows by 017: {"auditRows": {"auditRows": 1458, "matched": 1458, "championIndexEqual": 1458, "humanIndexEqual": 1458, "championCostEqual": 1458, "humanCostEqual": 1458, "bombOppEqual": 1458, "sha256": "29bddf765ecca4126ea4acfb787e4d05383cab4871df603033cc24f305ee8d28"}, "leadRows": {"leadRows": 269, "matched": 269, "championEqual": 269, "humanEqual": 269, "ctlEqual": 269, "sha256": "d7e95f36e7a3b15b1937da19bb97f8d8c004cc0693fc7dd249d570734a454c13"}}.

| measure | 017 | 017w | humans (recorded move) | 017w minus 017, round-cluster 95% | label |
|---|---|---|---|---|---|
| bombed / bomb-legal follow | 36.0% (368/1022) | 42.0% (429/1022) | 11.2% (114/1022) | +6.0 pp [+3.6, +8.7] pp | descriptive, not a gate |
| joker on an opponent's single/pair of K or lower | 25.0% (22/88) | 19.3% (17/88) | 13.6% (12/88) | -5.7 pp [-11.9, +0.0] pp | descriptive, not a gate |
| structure cost per play | 0.493 (506/1026) | 0.452 (487/1077) | 0.321 (252/784) | -0.041 [-0.078, -0.004] | descriptive, not a gate |
| same move as the unassisted human | 44.7% (651/1458) | 43.5% (634/1458) | — | -1.2 pp [-3.3, +0.6] pp | descriptive, not a gate |
| uncovered multi-card lead / lead positions | 14.9% (40/269) | 11.9% (32/269) | 7.4% (20/269) | -3.0 pp [-6.6, +0.3] pp | descriptive, not a gate |
| uncovered, beatable multi-card lead / lead positions | 10.8% (29/269) | 7.8% (21/269) | — | -3.0 pp [-6.6, +0.3] pp | descriptive, not a gate |
| owner's pattern (controlling single/pair available, uncovered multi-card lead led) | 8.9% (24/269) | 7.8% (21/269) | 5.6% (15/269) | -1.1 pp [-3.7, +1.6] pp | descriptive, not a gate |
| owner's pattern, beatable only | 6.7% (18/269) | 5.6% (15/269) | — | -1.1 pp [-3.6, +1.5] pp | descriptive, not a gate |
| section-67 critical decisions: optimal move | 73.0% (84/115) | 74.8% (86/115) | 85.2% (98/115) | +1.7 pp [-4.6, +8.2] pp | descriptive, not a gate; 017w unscored 0 |
| section-67 critical decisions, unassisted: optimal move | 74.7% (59/79) | 77.2% (61/79) | — | +2.5 pp [-5.9, +12.9] pp | descriptive, not a gate |
| S7a critical decisions: optimal move | 100.0% (4/4) | 100.0% (4/4) | 100.0% (4/4) | +0.0 pp [+0.0, +0.0] pp | descriptive, not a gate; 017w unscored 0 |

017w chose a different move from 017 at 494 of 1458 human decisions, 124 of 269 lead positions (classification differs) and 39 solver-panel positions (descriptive, not a gate).
Solver panels: the value of a chosen move is the stored row value when the choice equals 017's or the human's move; otherwise one exact null-window check with the panel's budget (section 67: 5M nodes / 30 s; S7a: 50M nodes / 300 s), at most 10 min in total: 23 checks, 0 over budget, 0 skipped for time (unscored, excluded from the rate). The solver panels are at <= 40 cards, where the deployed 9001 overrides the raw network: for 017w they measure endgame drift, not opening play (M4). The section-67 rows reproduce MODEL_STUDY section 67 for 017 (84/115 = 0.730; humans 98/115 = 0.852).

Published 017 references (W3 audit, lead audit): bomb 36.0% vs humans 11.2%; joker 25.0% vs 13.6%; structure cost 0.493 vs 0.321; agreement 44.7%; uncovered multi-card lead 14.9% vs 7.4%; owner's pattern 8.9% vs 5.6%; solver 0.730 vs 0.852.

## Belief v1 on the human positions (descriptive, not a gate)

Log loss per unseen copy of the belief v1 probabilities (mover public view only; truth = the recorded hands) against the uniform baseline; difference below 0 = better than uniform; round-cluster 95% interval. Self-play reference 0.793 vs 0.976.

| cards left | positions | copies | belief v1 | uniform | belief minus uniform [95%] | label |
|---|---|---|---|---|---|---|
| all | 1458 | 69540 | 0.936 | 1.030 | -0.094 [-0.114, -0.072] | descriptive, not a gate |
| 21-80 cards (training band) | 842 | 32590 | 0.840 | 0.979 | -0.139 [-0.169, -0.107] | descriptive, not a gate |
| >80 | 523 | 36264 | 1.035 | 1.088 | -0.053 [-0.066, -0.037] | descriptive, not a gate |
| 61-80 | 323 | 17110 | 0.937 | 1.057 | -0.120 [-0.144, -0.098] | descriptive, not a gate |
| 41-60 | 272 | 10417 | 0.826 | 0.977 | -0.152 [-0.200, -0.104] | descriptive, not a gate |
| 21-40 | 247 | 5063 | 0.543 | 0.716 | -0.173 [-0.225, -0.114] | descriptive, not a gate |
| <=20 | 93 | 686 | 0.315 | 0.479 | -0.164 [-0.241, -0.068] | descriptive, not a gate |

Training-range note: belief v1 was trained on single level-2 rounds without tribute at 21-80 cards (champion self-play); in S3 whole matches at other levels, tribute rounds and above 80 cards its marginals are outside that range (not a leak; reported in S7)

## S7a solver panel: 3 of 31 rounds (repair run 06:23-07:07 Toronto; descriptive, not a gate)

Only 3 of the 31 registered rounds have rows: the other rounds' solver workers ran out of JavaScript heap under the 10x budget (50M nodes / 300 s). The completed rounds are the ones whose search fit in memory, so they lean toward small endgames; this is not the M4 panel as planned (stages.log REPAIR/NOTE lines).

- human: 4/4 optimal (100.0%), round-cluster 95% [100.0, 100.0]% (descriptive, not a gate).
- champion: 4/4 optimal (100.0%), round-cluster 95% [100.0, 100.0]% (descriptive, not a gate).
- student: 3/3 optimal (100.0%), round-cluster 95% [100.0, 100.0]% (descriptive, not a gate).

## S6 arms replayed: round-end structure and hand-over (descriptive, not a gate)

217 deal pairs of the S6 contiguous prefix replayed per arm (seeds [4294500000, 4294500216], stop: deadline or STOP, 2003 s), focal seats only. A replayed round is the run's own round when points, plies and finishing order equal the stored row (the endgame solver has a time budget, so a replay can differ). Baselines SIM9001: four 9001 seats against each other (W3 audit); the S6 arms face raw 017 seats, so the comparison mixes opponents.

| measure | arm A | arm B | SIM9001 baseline | label |
|---|---|---|---|---|
| round end, seats with cards left: singles | 1.58 (n=253) | 1.65 (n=260) | 1.60 | descriptive, not a gate |
| round end: holds a joker | 20.2% (51/253) | 24.6% (64/260) | 20.8% | descriptive, not a gate |
| round end: holds a bomb | 4.3% (11/253) | 4.6% (12/260) | 3.3% | descriptive, not a gate |
| first player out: holds a bomb | 28.0% (177/632) | 26.7% (178/666) | 30.5% | descriptive, not a gate |
| first player out: holds a joker | 37.0% (234/632) | 40.4% (269/666) | 34.6% | descriptive, not a gate |
| table cards at the first bomb while following, median | 72 | 77 | 76 | descriptive, not a gate |
| rounds replayed (matching the stored row) | 434 (434) | 434 (434) | 162 rounds | descriptive, not a gate |
| hand-over corr(017 max Q, round points) | 0.68 (n=432) | 0.71 (n=429) | 0.58 (S1, 017) | descriptive, not a gate |
| hand-over corr(017w max Q, round points) | 0.69 | 0.72 | — | descriptive, not a gate |

S1 rows (hand-over headroom stage, src-s1 tool, M13 note applies): corr(017 max Q at the first focal <= 40 decision, round points): arm A 0.67 (rounds 798, contiguous pairs 400); arm B 0.50 (rounds 799, contiguous pairs 400); arm C 0.48 (rounds 799, contiguous pairs 400) (descriptive, not a gate).

## S6 (cited, the only acceptance; its reading is S6's own)

B minus A on 1322 common pairs: -0.10287443267776097, 95% [-0.17916741638078337, -0.02658144897473859]. Reading per protocol v2 stages.S6; see stages.log END S6.

## Not computed

- nothing

Limits: the human panel is 31 rounds from 4 tables (a handful of people), self-reported browser records; intervals are round-cluster bootstrap and reflect variation between rounds, not between people. Single counterfactual choices at positions reached by human play are not the networks' own games. Belief v1 was learned on 017 self-play and may misread human play (M13).
