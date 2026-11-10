# Lead audit: does champion 017 lead combinations it cannot win back?

Written 2026-11-09, about 22:55 US Eastern (Toronto). **Descriptive only.** Nothing here is a reward, gate, loss or acceptance metric. Trick wins and "cover" are intermediate signals (AGENTS.md whole-round objective rule); the only outcome column is the final round result (upgrade points), and in self-play it is association, not cause.

Prompted by the owner's observation: "the AI likes to lead cards it cannot win back. For example, it could keep control with singles, but suddenly leads a full house (三带二) while holding no big full house of its own."

Model: champion 017 (v000855042) Q-network, `/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx` (SHA-256 462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7, re-hashed for this report). The web danMCai-reason bot plays this raw network only above 40 table cards (belief search at 21–40, exact solver at 20 or fewer), so the **above-40 rows are the ones that bear on the deployed bot**; rows at 40 or fewer describe the raw network, not the deployed bot.

## Definitions (as implemented in `lead-audit.mjs`)

- **Lead position**: the acting seat starts a new trick (`game.trick` is empty: the opening lead, any free lead after a trick ends, including a lead inherited from a partner who went out), with more than one legal candidate and no candidate that empties the hand.
- **Lead type**: single, pair, triple, full house (三带二), straight, three consecutive pairs, plate (two consecutive triples), and bomb-type (bomb / straight flush / four jokers), from the engine's `type` field.
- **Unseen cards**: from the leader's view, the union of the other three hands at that moment (exactly the cards not in the leader's hand and not yet played, wild hearts included). Using the union means "someone could form X" is an upper bound for any one seat, and it includes the partner's cards.
- For a non-bomb lead L of type T and value r, judged from the leader's hand **after** the lead:
  - **W1**: holds a same-type, non-bomb combination of higher value than r (from the engine's candidate generator with L as the current trick).
  - **u**: highest value of a same-type, non-bomb combination that beats L and could be formed from the unseen cards (candidate generator on the unseen multiset; a direct count for singles and pairs, verified to match the generator on 1,996 test cases). **Unbeatable lead** = no such combination exists.
  - **W2**: the lead is unbeatable, or W1 holds and the leader's highest same-type value m >= u (nobody else can hold a higher one). Ties count as W2; the stricter m > u is stored as `w2strict` in rows.jsonl.
  - **Bomb**: holds any bomb, straight flush or four jokers after the lead.
  - **Uncovered** = no W1 and no bomb ("no same-type cover and no bomb"). **Uncovered & beatable** = uncovered and the lead is not unbeatable; this is the closest match to "cannot win back".
- **Multi-card types** for the headline: full house, straight, three consecutive pairs, plate.
- **Controlling single/pair alternative**: some legal single or pair lead at that position would have W2 status (same definition applied to that single or pair).
- **Trick outcome**: the seat that made the last play in the trick the lead started (leader, partner or opponent), from the actual continuation.
- **Champion choice** at a recorded position: arg-max Q of 017 over all legal candidates (the "finishing move if any" part of the convention never applies, because positions with a finishing move are excluded).
- **Table cards** = cards still in all four hands. Bands: >80, 61–80, 41–60, <=40.

## Data

- Recorded games: every `round-*.json` in `d1-snapshot-20261108/raw` and `d1-snapshot-20261109/raw`, de-duplicated by record id: **31 rounds from 4 matches** (tables). Lead positions: 371 in all, of which **269 unassisted human**, 93 assisted human (reference only), 9 Clint rule bot (excluded). No timeout actions. Trust level `unverified_browser`. **The number of distinct tables (4) and people is small**; nicknames and room numbers were not read into any output, so distinct people are not counted, but it is a handful. Intervals are round-cluster bootstrap (31 clusters, 2,000 draws), so they reflect variation between rounds, not between people, and are likely too narrow for "humans in general".
- Self-play: **2,000 single rounds completed** (all planned), seeds 4,300,200,000–4,300,201,999, no tribute, `createRound(seed)` deals, all four seats raw 017 greedy (finishing move if any, single candidate auto, else arg-max Q). 24,881 lead positions. Seed range check: grep of `ai/` and `/Users/stevensun/guandan-runtime.noindex/` found no use of 43002xxxxx (nearest used values 4,300,000,000–4,300,000,837).

## Summary (plain English)

1. **At the same 269 recorded positions, 017 would lead an uncovered multi-card combination about twice as often as the humans did**: 40/269 (14.9%) vs 20/269 (7.4%), difference +7.4 percentage points, 95% interval [+3.7, +11.4]. For "uncovered and beatable" (a same-type reply could top it and the leader has nothing same-type or bomb to come back with): 29/269 (10.8%) vs 11/269 (4.1%), +6.7 pp [+3.4, +10.1].
2. **The owner's pattern (controlling single or pair available, uncovered multi-card lead chosen)**: champion 24/269 (8.9%) vs humans 15/269 (5.6%), +3.3 pp [+0.4, +6.5]; restricted to "beatable" 18 vs 8, +3.7 pp [+0.7, +7.0]. Among the 148 positions where a controlling single/pair existed: 16.2% vs 10.1%, +6.1 pp [+0.7, +11.6].
3. **Above 40 table cards (raw 017 is what the deployed bot plays)**: uncovered multi-card leads 18/175 (10.3%) vs 9/175 (5.1%), +5.1 pp [+1.3, +9.4]. The excess is in 41–60 (27.9% vs 14.0%) and 61–80 (7.7% vs 1.9%); above 80 cards there is no difference (2.5% each). **Full houses specifically are not where the excess is in the recorded games above 40**: 2 of 30 champion full-house leads were uncovered vs 1 of 24 human ones; the excess above 40 is mostly straights, consecutive pairs and plates. No recorded position above 40 matched "uncovered full house while a controlling single was available"; all six full-house examples in Table 4 are at 40 or fewer cards, where the deployed bot does not use the raw network. The owner may have seen the pattern in rounds outside these 31 records. In self-play above 40 cards, raw 017 led an uncovered & beatable full house with a controlling single available at 130 of 14,778 lead positions (0.9%) (Table 3d).
4. **The champion leads multi-card combinations much more, and singles/pairs much less, than these humans**: multi-card 133/269 (49%) vs 87/269 (32%); straights 23.0% vs 11.2%; singles and pairs 41.3% vs 63.2%. Part of the uncovered excess is simply more multi-card leads, but the uncovered share within multi-card leads is also higher (30.1% vs 23.0%, +7.1 pp [+0.3, +14.1]; beatable 21.8% vs 12.6%, +9.2 pp [+2.6, +16.3]).
5. **017 is close to indifferent at many of these choices**: at the 40 positions where it would lead an uncovered multi-card combination, the Q gap to the next candidate has median 0.029, and 18/40 are below 0.02. Some "second" candidates are the same ranks in different suits, so the gap to a genuinely different lead is often larger; this was not separated.
6. **Self-play association (017 vs itself, 2,000 rounds; confounded by hand strength)**: after uncovered & beatable multi-card leads the opponent won the trick 58.2% of the time (covered multi-card 45.2%, controlling single/pair 28.7%), and the leader's team finished the round at −0.49 points on average [−0.59, −0.40], against +0.39 for covered multi-card leads and +0.39 for controlling single/pair leads. When a controlling single/pair was available, the leader team averaged −0.20 [−0.31, −0.09] after an uncovered multi-card lead vs +0.36 [+0.29, +0.43] after leading a single/pair. This does **not** show that the lead caused the loss: weak hands both lose more and have fewer covered options. It is consistent with the owner's concern and worth a controlled test (counterfactual continuations from the same positions), not a training signal.
7. Human trick outcomes (Table 2) are small-n: after the 11 uncovered & beatable human multi-card leads the opponent won the trick 3 times; too few to compare.

## Caveats

- Small recorded sample (4 tables, 31 rounds, a handful of people). "Humans" means these players, not humans in general.
- "Unseen" is the union of three hands, so W2 and "beatable" are judged against the best combination any one seat could form if it held all unseen cards; real seats hold less. This makes "beatable" generous for both sides equally.
- Cover is judged only by same-type combinations and bombs. It ignores that a partner can take the trick, that the leader may not need the trick back, and tempo or hand-shaping reasons for a lead. A strong player may lead an uncovered full house on purpose (for example to dump a weak triple while opponents are short); these tables cannot tell good leads from bad ones.
- Champion rows in recorded games have no continuation (the human's play is what happened), so their trick outcome is unknown.
- Exact-match "same play" (67/269) counts different suits of the same ranks as different plays, so it understates agreement.
- Self-play final points are association only, single rounds, no tribute, 017 against 017; no human or other opponent.

## Table 1. Recorded games: unassisted humans vs champion 017 at the same lead positions (paired)

Unassisted human lead positions: 269 in 31 rounds from 4 matches (tables). The champion column is what 017 would lead at the same position (arg-max Q; no finishing move exists at these positions by definition).

### 1a. Lead-type distribution

| lead type | humans | champion 017 | same choice as human |
|---|---|---|---|
| single | 109/269 (40.5%) | 74/269 (27.5%) | 28 |
| pair | 61/269 (22.7%) | 37/269 (13.8%) | 10 |
| triple | 12/269 (4.5%) | 13/269 (4.8%) | 2 |
| full house (三带二) | 31/269 (11.5%) | 38/269 (14.1%) | 9 |
| straight | 30/269 (11.2%) | 62/269 (23.0%) | 10 |
| three consecutive pairs | 17/269 (6.3%) | 28/269 (10.4%) | 6 |
| plate (two consecutive triples) | 9/269 (3.3%) | 5/269 (1.9%) | 2 |
| bomb / straight flush / four jokers | 0/269 (0.0%) | 12/269 (4.5%) | 0 |
| exact same play | | | 67/269 |

### 1b. Multi-card leads (full house, straight, consecutive pairs, plate): cover status

"Uncovered" = after the lead the leader holds no higher same-type combination (W1 false) and no bomb. "Uncovered, beatable" additionally requires that some same-type reply could be formed from the unseen cards (the lead is not itself the top possible).

| | humans | champion 017 | champion − human, round-cluster bootstrap 95% |
|---|---|---|---|
| multi-card leads, uncovered (share of multi-card leads) | 20/87 (23.0%) | 40/133 (30.1%) | +7.1 pp [+0.3, +14.1] |
| multi-card leads, uncovered and beatable (share of multi-card leads) | 11/87 (12.6%) | 29/133 (21.8%) | +9.2 pp [+2.6, +16.3] |
| uncovered multi-card lead (share of ALL lead positions) | 20/269 (7.4%) | 40/269 (14.9%) | +7.4 pp [+3.7, +11.4] |
| uncovered, beatable multi-card lead (share of ALL lead positions) | 11/269 (4.1%) | 29/269 (10.8%) | +6.7 pp [+3.4, +10.1] |
| controlling single/pair available AND uncovered multi-card lead chosen (share of ALL positions) | 15/269 (5.6%) | 24/269 (8.9%) | +3.3 pp [+0.4, +6.5] |
| controlling single/pair available AND uncovered, beatable multi-card lead chosen | 8/269 (3.0%) | 18/269 (6.7%) | +3.7 pp [+0.7, +7.0] |

Positions where a controlling single or pair (W2) was available: 148/269 (55.0%) (single 124, pair 84).
Among those positions, uncovered multi-card lead: humans 15/148 (10.1%), champion 24/148 (16.2%), difference +6.1 pp [+0.7, +11.6].

### 1c. Cover levels per multi-card type (human leads | champion leads)

| type | side | leads | W1 (any higher same type) | W2 (top possible same type, or lead unbeatable) | bomb after lead | uncovered (no W1, no bomb) | uncovered & beatable |
|---|---|---|---|---|---|---|---|
| full house (三带二) | human | 31 | 16/31 (51.6%) | 5/31 (16.1%) | 24/31 (77.4%) | 5/31 (16.1%) | 2/31 (6.5%) |
| full house (三带二) | champion | 38 | 21/38 (55.3%) | 6/38 (15.8%) | 25/38 (65.8%) | 10/38 (26.3%) | 7/38 (18.4%) |
| straight | human | 30 | 11/30 (36.7%) | 12/30 (40.0%) | 20/30 (66.7%) | 9/30 (30.0%) | 6/30 (20.0%) |
| straight | champion | 62 | 20/62 (32.3%) | 20/62 (32.3%) | 35/62 (56.5%) | 21/62 (33.9%) | 14/62 (22.6%) |
| three consecutive pairs | human | 17 | 8/17 (47.1%) | 4/17 (23.5%) | 14/17 (82.4%) | 3/17 (17.6%) | 1/17 (5.9%) |
| three consecutive pairs | champion | 28 | 12/28 (42.9%) | 1/28 (3.6%) | 21/28 (75.0%) | 5/28 (17.9%) | 4/28 (14.3%) |
| plate (two consecutive triples) | human | 9 | 3/9 (33.3%) | 2/9 (22.2%) | 4/9 (44.4%) | 3/9 (33.3%) | 2/9 (22.2%) |
| plate (two consecutive triples) | champion | 5 | 1/5 (20.0%) | 0/5 (0.0%) | 0/5 (0.0%) | 4/5 (80.0%) | 4/5 (80.0%) |
| triple | human | 12 | 8/12 (66.7%) | 4/12 (33.3%) | 7/12 (58.3%) | 3/12 (25.0%) | 0/12 (0.0%) |
| triple | champion | 13 | 10/13 (76.9%) | 5/13 (38.5%) | 6/13 (46.2%) | 2/13 (15.4%) | 0/13 (0.0%) |
| pair | human | 61 | 52/61 (85.2%) | 28/61 (45.9%) | 38/61 (62.3%) | 6/61 (9.8%) | 3/61 (4.9%) |
| pair | champion | 37 | 24/37 (64.9%) | 21/37 (56.8%) | 13/37 (35.1%) | 10/37 (27.0%) | 5/37 (13.5%) |
| single | human | 109 | 97/109 (89.0%) | 66/109 (60.6%) | 75/109 (68.8%) | 7/109 (6.4%) | 2/109 (1.8%) |
| single | champion | 74 | 67/74 (90.5%) | 34/74 (45.9%) | 48/74 (64.9%) | 3/74 (4.1%) | 1/74 (1.4%) |

### 1d. By table cards (all four seats' cards still in hands)

| table cards | positions | humans: uncovered multi-card lead | champion: uncovered multi-card lead | champion − human (95%) | humans: ctl alt + uncovered multi | champion: ctl alt + uncovered multi |
|---|---|---|---|---|---|---|
| >80 | 80 | 2/80 (2.5%) | 2/80 (2.5%) | +0.0 pp [-3.6, +3.8] | 1/80 (1.2%) | 2/80 (2.5%) |
| 61-80 | 52 | 1/52 (1.9%) | 4/52 (7.7%) | +5.8 pp [+0.0, +13.7] | 0/52 (0.0%) | 1/52 (1.9%) |
| 41-60 | 43 | 6/43 (14.0%) | 12/43 (27.9%) | +14.0 pp [+0.0, +30.2] | 5/43 (11.6%) | 7/43 (16.3%) |
| <=40 | 94 | 11/94 (11.7%) | 22/94 (23.4%) | +11.7 pp [+1.1, +22.7] | 9/94 (9.6%) | 14/94 (14.9%) |
| >40 (all above 40) | 175 | 9/175 (5.1%) | 18/175 (10.3%) | +5.1 pp [+1.3, +9.4] | 6/175 (3.4%) | 10/175 (5.7%) |
| all | 269 | 20/269 (7.4%) | 40/269 (14.9%) | +7.4 pp [+3.7, +11.4] | 15/269 (5.6%) | 24/269 (8.9%) |

Champion Q gap (top − second) at the positions where it would lead an uncovered multi-card combination: median 0.029, 18/40 below 0.02 (near-ties).

Reference only (not part of the comparison): assisted human leads 93, uncovered multi-card 7/93 (7.5%); champion at those positions 16/93 (17.2%).

## Table 2. Recorded games: trick outcome after unassisted human leads (actual continuation)

Who won the trick that the lead started (last play of the trick). Champion choices have no actual continuation in the records (the human's play was what happened), so this table is humans only.

| human lead class | leads | won by leader | by partner | by opponent |
|---|---|---|---|---|
| multi-card, uncovered & beatable | 11 | 6/11 (54.5%) | 2/11 (18.2%) | 3/11 (27.3%) |
| multi-card, uncovered but unbeatable | 9 | 6/9 (66.7%) | 1/9 (11.1%) | 2/9 (22.2%) |
| multi-card, covered (W1 or bomb) | 67 | 32/67 (47.8%) | 12/67 (17.9%) | 23/67 (34.3%) |
| single/pair, W2 (controlling) | 94 | 50/94 (53.2%) | 18/94 (19.1%) | 26/94 (27.7%) |
| single/pair, not W2 | 76 | 21/76 (27.6%) | 15/76 (19.7%) | 40/76 (52.6%) |
| triple | 12 | 7/12 (58.3%) | 1/12 (8.3%) | 4/12 (33.3%) |

## Table 3. Champion 017 self-play (all four seats raw 017, greedy; single rounds, no tribute)

Rounds completed: 2000 (seeds [4300200000, 4300201999]); lead positions: 24881. Final round points are the leader team's signed upgrade (+1/+2/+3 if the team won the round, −1/−2/−3 otherwise); intervals are seed-cluster bootstrap 95% (2,000 draws). ASSOCIATION ONLY: which lead the network chooses depends on the hand, so these numbers are confounded by hand strength and do not say the lead caused the result.

### 3a. Per lead type

| lead type | leads | share | uncovered | uncovered & beatable | trick won by leader | partner | opponent | leader team final points |
|---|---|---|---|---|---|---|---|---|
| single | 9535 | 38.3% | 713/9535 (7.5%) | 197/9535 (2.1%) | 4111/9535 (43.1%) | 1557/9535 (16.3%) | 3867/9535 (40.6%) | +0.303 [+0.249, +0.358] (n=9535) |
| pair | 4451 | 17.9% | 953/4451 (21.4%) | 530/4451 (11.9%) | 1968/4451 (44.2%) | 683/4451 (15.3%) | 1800/4451 (40.4%) | +0.174 [+0.100, +0.247] (n=4451) |
| triple | 1392 | 5.6% | 471/1392 (33.8%) | 241/1392 (17.3%) | 673/1392 (48.3%) | 176/1392 (12.6%) | 543/1392 (39.0%) | +0.271 [+0.142, +0.403] (n=1392) |
| full house (三带二) | 4103 | 16.5% | 1086/4103 (26.5%) | 734/4103 (17.9%) | 1556/4103 (37.9%) | 607/4103 (14.8%) | 1940/4103 (47.3%) | +0.173 [+0.106, +0.236] (n=4103) |
| straight | 3140 | 12.6% | 955/3140 (30.4%) | 566/3140 (18.0%) | 1372/3140 (43.7%) | 396/3140 (12.6%) | 1372/3140 (43.7%) | +0.105 [+0.024, +0.184] (n=3140) |
| three consecutive pairs | 1773 | 7.1% | 677/1773 (38.2%) | 464/1773 (26.2%) | 810/1773 (45.7%) | 184/1773 (10.4%) | 779/1773 (43.9%) | +0.190 [+0.089, +0.287] (n=1773) |
| plate (two consecutive triples) | 393 | 1.6% | 186/393 (47.3%) | 131/393 (33.3%) | 228/393 (58.0%) | 25/393 (6.4%) | 140/393 (35.6%) | +0.313 [+0.102, +0.524] (n=393) |
| bomb / straight flush / four jokers | 94 | 0.4% | n/a | n/a | 85/94 (90.4%) | 0/94 (0.0%) | 9/94 (9.6%) | +0.809 [+0.418, +1.204] (n=94) |

### 3b. Lead classes

| lead class | leads | trick won by leader | partner | opponent | leader team final points |
|---|---|---|---|---|---|
| multi-card, uncovered & beatable | 1895 | 552/1895 (29.1%) | 240/1895 (12.7%) | 1103/1895 (58.2%) | -0.493 [-0.588, -0.400] (n=1895) |
| multi-card, uncovered but unbeatable | 1009 | 810/1009 (80.3%) | 13/1009 (1.3%) | 186/1009 (18.4%) | -0.126 [-0.258, +0.004] (n=1009) |
| multi-card, covered (W1 or bomb) | 6505 | 2604/6505 (40.0%) | 959/6505 (14.7%) | 2942/6505 (45.2%) | +0.393 [+0.348, +0.438] (n=6505) |
| single/pair, W2 (controlling) | 6742 | 4032/6742 (59.8%) | 777/6742 (11.5%) | 1933/6742 (28.7%) | +0.394 [+0.316, +0.473] (n=6742) |
| single/pair, not W2 | 7244 | 2047/7244 (28.3%) | 1463/7244 (20.2%) | 3734/7244 (51.5%) | +0.139 [+0.078, +0.198] (n=7244) |
| triple | 1392 | 673/1392 (48.3%) | 176/1392 (12.6%) | 543/1392 (39.0%) | +0.271 [+0.142, +0.403] (n=1392) |
| bomb-type lead | 94 | 85/94 (90.4%) | 0/94 (0.0%) | 9/94 (9.6%) | +0.809 [+0.418, +1.204] (n=94) |

### 3c. Uncovered multi-card leads when a controlling single/pair was available, by table cards

| table cards | lead positions | ctl single/pair available | of those: uncovered multi-card lead | of those: uncovered & beatable | final points: ctl available & uncovered multi | ctl available & single/pair led |
|---|---|---|---|---|---|---|
| >80 | 5769 | 2661/5769 (46.1%) | 148/2661 (5.6%) | 144/2661 (5.4%) | -0.257 [-0.608, +0.100] (n=148) | +0.484 [+0.343, +0.627] (n=1123) |
| 61-80 | 4198 | 1958/4198 (46.6%) | 232/1958 (11.8%) | 219/1958 (11.2%) | -0.241 [-0.544, +0.072] (n=232) | +0.566 [+0.403, +0.726] (n=1011) |
| 41-60 | 4811 | 2414/4811 (50.2%) | 379/2414 (15.7%) | 313/2414 (13.0%) | -0.164 [-0.405, +0.088] (n=379) | +0.615 [+0.480, +0.746] (n=1400) |
| <=40 | 10103 | 6472/10103 (64.1%) | 868/6472 (13.4%) | 298/6472 (4.6%) | -0.194 [-0.337, -0.049] (n=868) | +0.213 [+0.130, +0.295] (n=4805) |
| >40 (all above 40) | 14778 | 7033/14778 (47.6%) | 759/7033 (10.8%) | 676/7033 (9.6%) | -0.206 [-0.382, -0.039] (n=759) | +0.559 [+0.463, +0.652] (n=3534) |
| all | 24881 | 13505/24881 (54.3%) | 1627/13505 (12.0%) | 974/13505 (7.2%) | -0.199 [-0.312, -0.093] (n=1627) | +0.360 [+0.292, +0.426] (n=8339) |

### 3d. Self-play: full house leads specifically (the owner's example)

| table cards | lead positions | full house led | uncovered & beatable full house | ... with a controlling single available | leader team final points: uncovered & beatable FH with ctl single | trick to opponent after those |
|---|---|---|---|---|---|---|
| >80 | 5769 | 1082/5769 (18.8%) | 31/1082 (2.9%) | 11/5769 (0.2%) of positions | -0.909 [-2.091, +0.364] (n=11) | 9/11 (81.8%) |
| 61-80 | 4198 | 792/4198 (18.9%) | 96/792 (12.1%) | 36/4198 (0.9%) of positions | -0.250 [-0.972, +0.472] (n=36) | 22/36 (61.1%) |
| 41-60 | 4811 | 915/4811 (19.0%) | 218/915 (23.8%) | 83/4811 (1.7%) of positions | -0.157 [-0.683, +0.360] (n=83) | 52/83 (62.7%) |
| <=40 | 10103 | 1314/10103 (13.0%) | 389/1314 (29.6%) | 154/10103 (1.5%) of positions | -0.247 [-0.601, +0.096] (n=154) | 98/154 (63.6%) |
| >40 (all above 40) | 14778 | 2789/14778 (18.9%) | 345/2789 (12.4%) | 130/14778 (0.9%) of positions | -0.246 [-0.662, +0.189] (n=130) | 83/130 (63.8%) |
| all | 24881 | 4103/24881 (16.5%) | 734/4103 (17.9%) | 284/24881 (1.1%) of positions | -0.246 [-0.532, +0.031] (n=284) | 181/284 (63.7%) |

Self-play share of all lead positions that are uncovered multi-card leads: 2904/24881 (11.7%); uncovered & beatable: 1895/24881 (7.6%) (recorded-game positions, champion choice: 40/269 (14.9%) and 29/269 (10.8%)).

## Table 4. Example positions

Omitted from the committed copy: the examples are hands taken from private human records. They stay in the local run folder (`window3-prep-20261109/lead-audit/REPORT.md`).
