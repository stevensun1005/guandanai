<div align="center">

# GuandanAI

### A table for friends. One link to play.

Four-player GuanDan with bots running in your browser, private rooms and practical hand tools.

[![Deploy](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml/badge.svg)](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml)
[![Version](https://img.shields.io/github/package-json/v/stevensun1005/guandanai?color=ddb050)](./CHANGELOG.md)
![Runtime](https://img.shields.io/badge/Runtime-Browser_%2B_WebAssembly-4a7c59)

**[Play now](https://stevensun1005.github.io/guandanai/) · [Download a release](https://github.com/stevensun1005/guandanai/releases/latest) · [简体中文](./README.md) · [Contributing](./CONTRIBUTING.md)**

</div>

## Table assistance and hand reset

On desktop windows at least 800 pixels wide and 700 pixels tall, Top 5 uses a reserved sidebar with its own scrolling. Collapsing it restores table space while keeping selection ratings. Controls reserve their own space as cards and timers change; short desktop windows use a smaller action column or a two-column grid. Round-result actions stay inside the result card. Windows shorter than 700 pixels use a scrollable layout instead of overlapping overlays. The **复原** button restores loose cards to rank order, preserves manual groups and supports undo. In four-hand practice it restores the suggested grouping instead. See the [playing guide](web/docs/PLAYING.md) and [coach guide](web/docs/MOVE_COACH.md).

![An actual game](./web/docs/media/table-desktop.png)

<details>
<summary>More views: mobile help and match history</summary>

<p align="center"><img src="./web/docs/media/help-mobile.png" width="280" alt="Mobile controls guide" /> <img src="./web/docs/media/match-history-mobile.png" width="280" alt="Match results and public scorecard on mobile" /></p>

</details>

The [continuous research dashboard](http://127.0.0.1:8767/) follows the current task. The A/B evaluation is complete. Evidence guides sequential short diagnostics and full-network training experiments, with authorization ending **Wednesday, November 11 at noon Toronto time**. See the [autonomous research window](ai/research/AUTONOMOUS_RESEARCH_20261107.md) for deadline protection, memory limits and reporting.

The owner has authorized sequential four-hour Windows A/B training windows followed by preregistered independent round evaluation. The [historical A/B dashboard](http://127.0.0.1:8766/) shows measured progress and resources; see the [Windows handoff](ai/research/WINDOWS_RETURN_20261106.md) for fixed deadlines, evidence and recovery boundaries. The website champion stays unchanged. Training progress is not evidence of stronger play.

Tribute/return learning is an independent two-head specialist. See its [protocol and integration requirements](ai/shared/tribute/README.md). It is not enabled on the website yet; the champion menu is unchanged. The [specialist Mac handoff](ai/research/TRIBUTE_MAC_HANDOFF.md) covers the separate checkpoint/data package and pending MPS adaptation.

## Code and model entry points

[Web application](web/README.md) · [AI](ai/README.md) · [danMCai](ai/danMCai/README.md) · [GuanZero](ai/guanzero/README.md) · [Migration guide](ai/research/STRUCTURE_MIGRATION.md)

## Bring your friends

The in-game scorecard keeps earlier rounds, finishing orders and public action totals throughout the match. Switch rounds, filter players or download the whole public match log; held cards are excluded. Completed rounds also travel with seat recovery.

1. Enter a nickname and create a room.
2. Pick a seat and copy the invitation link.
3. Friends open the link and take their seats. The host starts the game.

Empty seats are filled by bots. Play alone or with up to three friends. The host runs the table and computes bot turns. Within three hours, reopening the same build in the same browser can restore the original room after a refresh or closed tab; friends reclaim their original seat credentials. Explicit exit clears this local recovery.

Use the lobby’s start-settings dialog to set each team’s level, the active team, the previous finishing order and failed A attempts. Desktop/tablet name plates are symmetric, card backs can be hidden, and rotation/fullscreen changes reflow without rewriting the viewport. The new final-chance option gives the other team one A attempt after a team has exhausted three; the table shows A1/A2/A3 or A末. Straight-flush selection now counts combinations and clears the selection after a full cycle.

Clint’s standalone rules include single-card following, level-card/joker priorities and partner lead-type inference from public history. See the [rule module](web/src/rule-bot/README.md#公开牌史策略更新); neural policies remain independent.

## What is included

Spectate a room from the lobby using its four-digit code. Spectators receive public plays and hand counts, take no seat and cannot act; the host can manage spectator voice from Options. The face-up practice entry is now labeled Training, with clearer black name text and a plain centered pass label. [Spectator guide](web/docs/PLAYING.md#观战朋友的牌桌)

Online rounds with at least two people are archived as structured, pseudonymous records after completion. The host uploads once, with offline retry and deduplication. Private JSON exports and human-action JSONL preparation are available; collected data is not automatically fed into active training. See [collection and export](./web/collector/README.md).

| Feature             | In the game                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Four-player GuanDan | Two decks, wild cards, bombs, tribute, partner lead and level progression                                                                                                                                                                              |
| Friend rooms        | Invitations, seat selection, temporary bot takeover and original-tab recovery                                                                                                                                                                          |
| Browser inference   | Versioned trained models in a browser Web Worker                                                                                                                                                                                                       |
| Training versions   | GuanZero run-version names and gate-verified danMCai champions                                                                                                                                                                                         |
| Hand tools          | Dragging, sweeping, manual groups, smart/rank/suit ordering and 30-step arrangement undo/redo                                                                                                                                                          |
| Clear actions       | Selection feedback, keyboard navigation and optional play confirmation                                                                                                                                                                                 |
| Table emotes        | Five presets (cappuccino, flower and bomb thrown at a seat; sunglasses, crying) with effects, spoken small-talk phrases (no play signals), from a round button at the bottom right, next to the sort button; computer seats answer gifts; no free text |
| Public scorecards   | Select earlier rounds, filter public actions and export a round or the match                                                                                                                                                                           |
| Practice            | An explicit face-up solo table with notes, step-by-step play and portable records                                                                                                                                                                      |
| Static deployment   | GitHub Pages; no inference server or API key required                                                                                                                                                                                                  |

The menu contains Clint rules, the latest two GuanZero generations, danMCai P0 and the last two danMCai gate champions. The default is the **current danMCai gate champion**. GuanZero names use the format `guanzero-adp-gpubatch-44752`; the catalog and selection guide own the actual current versions. Gate promotion is development selection, not independent strength acceptance. The local GuanZero run freezes a checkpoint every twelve hours and publishes those exact weights after all two opponents have played 500 matches each. Historical weights remain archived. See [selection and publishing](./web/docs/WEB_MODELS.md). Neural decisions do not apply Clint heuristics. Champions from the Mac continuation follow the same accepted-gate and SHA checks before updating the default and move-feedback model.

Training now offers hand arrangement and the original face-up table; endgame practice is still marked as unavailable. Arrangement practice compares reference groups with your edits, keeps four seats separate, and exports local records. Its grouping score is not a neural probability; reference-assisted records are not automatically uploaded or trained on. The practice table keeps its action grid in one place, including after your hand is empty. Played cards stay readable in a scrollable area, while notes and round results sit in the lower-left corner. See the [practice guide](./web/docs/PRACTICE.md).

[Model catalog and evidence](./web/docs/WEB_MODELS.md) · [Reproducible model training](./ai/research/MODEL_TRAINING.md)

The **[model research report](./ai/research/MODEL_STUDY.md)** documents the shared networks, actual learning algorithms, full-match objective, positive and negative results, and evidence limits. Completed experiments are updated with checkpoint hashes and seed-level outcomes; development peaks are kept separate from independent acceptance tests.

The project aims to keep improving overall playing strength and become a training partner that helps its owner review games and improve. An 80% win rate is only a historical threshold against specific opponents, not the overall goal. Performance across opponents, partnership play and teaching value require separate evidence; planned abilities are not claimed as implemented or validated.

Completed multiplayer rounds with at least two human seats are collected by the host into private cloud storage. Records include the room number and human seat nicknames at play start (computer names are null), and omit chat, voice and seat credentials; offline retries and deduplication are supported. Private JSON/JSONL exports remain isolated research data and are not automatically fed into active training. Rounds from [Clint's site](https://clintsun1977.github.io/guandan/) are uploaded to the same store in the same format (`appVersion` starting with `c1977`). See [collection and export](./web/collector/README.md).

GuanZero development evaluation now includes Clint and the accepted danMCai champion. Each opponent defaults to 500 complete matches (250 paired seeds with sides swapped). The dashboard separates live progress from completed results and historical 200-match batches. See the [evaluation protocol](ai/guanzero/README.md#开发评测对手).

GuanZero evaluation rows use the training run and actual frozen export version, with the opponent and progress shown separately. Old snapshots without verifiable version records use a SHA suffix. See [dashboard model names](ai/guanzero/README.md#面板中的评测模型名).

## Run locally

Node.js **20.19+** is required; CI uses Node.js 24.

```bash
git clone https://github.com/stevensun1005/guandanai.git
cd guandanai
npm ci
npm run build
npm run dev
```

Open **http://127.0.0.1:8765/**. Rebuild and refresh after source changes.

```bash
npm test
npm run format:check
npm run build
```

Python is a developer tool for model export, training and browser validation. Players and the static build do not need it. Tested Python dependencies are recorded in `ai/environment/requirements-dev.txt` and `ai/environment/requirements-models.txt`.

Validation includes three viewport sizes, numerical checks for both models, recovery races and three complete automated matches: **37 rounds and 2,957 actions** across two- and four-client sessions. See the [validation scope and reports](./web/docs/TESTING.md).

## A project with clear boundaries

```text
web/                      Web application
  src/                    Game, UI, rooms and browser inference
  tools/                  Build, preview and packaging
  tests/                  Web and browser tests
  docs/                   Playing, controls and deployment
ai/                       AI
  danMCai/                  danMCai training, data, evaluation and weights
  guanzero/               Separate GuanZero training and evaluation
  shared/                 Shared simulation and fixed positions
  research/               Research, handoff and experiment evidence
  publishing/             Browser model publishing and archival
  environment/            Python dependency lists
```

Production assets are bundled into `web/dist/`; edit `web/src/`, not the build output. Rules do not depend on DOM or session state. Model observations are explicitly limited to the acting player's hand and public information.

## Publish

Pull requests run unit checks, formatting, the build and real browser play/import smoke tests without deploying. Push to `main` to deploy after those checks pass. Documentation and experimental checkpoint archival pushes do not trigger deployment. Configure Pages to use **GitHub Actions** as its source. All inference resources are included in the static deployment.

The application uses relative asset URLs and supports repository subpaths. See the [deployment guide](./web/docs/DEPLOYMENT.md).

## Recovery and boundaries

A guest can refresh the original browser tab or reconnect after a data-channel interruption. The host verifies the original seat credential, sends its current snapshot and cancels any unfinished bot turn for the returning player. A page-version mismatch blocks starting the table. If an incoming event queue stops advancing, the guest can resynchronize on the existing connection without extending the host’s turn clock.

Recovery is tab-local; it does not provide account-based or cross-device sign-in. The host must remain online. If the host leaves, guests can continue independently against bots running in their own browser; automatic host migration is not implemented.

Validation covers desktop Chrome, simulated phone layouts, public PeerJS signaling, multiple browser contexts, full rounds, tribute and recovery races. Different physical devices and networks still need broader long-running playtests. See [testing](./web/docs/TESTING.md) and [room recovery](./web/docs/ROOMS.md).

## Improve one hand at a time

For a useful [issue](https://github.com/stevensun1005/guandanai/issues), include the device, browser, page version and steps. Rule or bot issues benefit from a concrete hand and the public actions leading to it. UI changes benefit from screenshots.

[Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md) · [Roadmap](./web/docs/ROADMAP.md)

## Model research status

The complete 1.37-million-parameter network has undergone staged unfreezing experiments. Four-arm studies of public or training-only privileged critics and fresh or repeated openings completed 256 pilot and 1,024 extended full-match training trajectories. Repeated openings are not independent new deals, and training counts are not acceptance-test counts. Published code, evidence and checkpoint access are in `main`; the public record has not validated an independent 80% full-match win rate, and those historical experiments do not determine the current web default. The current default follows actual danMCai champion promotions. The [research report](./ai/research/MODEL_STUDY.md) and its evidence snapshot own the latest methods and conclusions.

`npm run eval:table -- --pairs=1000 --opponent=rule` evaluates complete matches through the same preparation and decision functions used by the web controller and Worker, including styles, public history, finishing shortcuts and endgame search. See the [research report](./ai/research/MODEL_STUDY.md) for completed sample sizes and limitations; pipeline smoke checks are not evidence of improved playing strength. This legacy full-match entry uses the original rules for `rule`; the GuanZero evaluator selects Clint explicitly with `--opponents=clint`.

GuanZero is a separate training route with batched GPU inference and a read-only live dashboard. Its development opponents are Clint (`rules-v2`) and the danMCai gate champion. Paired seeds and frozen-model fingerprints keep the results traceable; the legacy trainer can add Clint through an isolated supplement process. See [GuanZero](./ai/guanzero/README.md). Development results are not independent acceptance tests.

## Documentation

| Task                                  | Start here                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play, arrange cards or replay         | [Playing](./web/docs/PLAYING.md) · [Practice](./web/docs/PRACTICE.md)                                                                                                         |
| Invite friends or recover a seat      | [Rooms](./web/docs/ROOMS.md)                                                                                                                                                  |
| Develop, validate or deploy           | [Contributing](./CONTRIBUTING.md) · [Architecture](./web/docs/ARCHITECTURE.md) · [Testing](./web/docs/TESTING.md) · [Deployment](./web/docs/DEPLOYMENT.md)                    |
| Understand bots or reproduce training | [Bots](./web/docs/BOTS.md) · [Training entry points](./ai/research/MODEL_TRAINING.md) · [Historical training log](./ai/research/TRAINING_RUN.md)                              |
| Review evidence and planned work      | [Research report](./ai/research/MODEL_STUDY.md) · [Improvement proposals and implementation status](./ai/research/IMPROVEMENT_PROPOSAL.md) · [Roadmap](./web/docs/ROADMAP.md) |

Fixed full-match evaluation supports two champion seats against two Clint seats or two seats of a frozen latest export. [Protocols and evidence](ai/research/evaluation/champion-clint-latest-20261105/) keep paired seeds, model fingerprints, draws and uncertainty separate from deployment decisions.

**Optional move feedback:** the host first permits it for the room, then each player independently opts in. The current danMCai champion rates selected moves and retains the last played move. Percentages are relative model-value scores, not win probabilities. [How it works](web/docs/MOVE_COACH.md).

Move feedback can be selected before solo play or in an allowed room. A responsive Top 5 panel shows actual cards and relative scores; clicking selects cards without playing them. Percentages are relative action-value scores, not win probabilities. See [move feedback](web/docs/MOVE_COACH.md).

Moving training to a MacBook: the [Mac handoff](ai/research/MAC_HANDOFF.md) covers native dependencies, checksummed model/Adam/replay transfer and one fixed 24-hour window. Windows artifacts remain intact. This M1 Pro passed real MPS/Adam/ONNX probes and completed its single authorized window in an isolated frozen checkout; the handoff records the final stop and verified checkpoint/data restoration. Sampler concurrency can be tuned through a named, measured protocol change while preserving desktop memory headroom and the original deadline. The authorized gate schedule now prioritizes the newest snapshot, skips the ordinary historical backlog, and retains up to two former champions at a three-hour interval plus the existing P0 regression checks; see the [scheduling guide](ai/research/CONTINUOUS_TRAINING.md#新快照优先的门控调度). The handoff records the fixed deadline, memory-accounting correction and final results; completing training does not establish independent playing strength.

A [read-only stop audit](ai/research/CONTINUOUS_TRAINING.md#固定窗口的停机核验) checks final weights, optimizer state, retained replay and restored archives after a fixed window ends.

The final champion from this Mac window has been verified on the website, and the window-specific publication check has ended. A new training window requires separate authorization; see the [final handoff](ai/research/MAC_HANDOFF.md).

The fixed paired single-round comparison is complete and found no clear strength difference between the champion and final learner. Training remains stopped. See the [Windows return handoff](ai/research/WINDOWS_RETURN_20261106.md) for the checked model/Adam/replay bundle and next-experiment recommendations.

GuanZero can resume its optimizer and sample cursor in a fixed training window and evaluate a frozen checkpoint every twelve hours in the current 48-hour window, playing 500 matches against each of two opponents. See the [training guide](ai/guanzero/README.md).

Research continuation games use the verified danMCai champion frozen at batch start. Teacher changes and inherited work are tracked in the [specialist protocol](ai/shared/tribute/README.md).

A dedicated Windows watchdog can resume the fixed GuanZero training window after a supervisor exit. See [recovery](ai/guanzero/README.md#自动恢复) for checkpoint checks, the stop control and the original deadline.

The owner extended the local GuanZero run through **2026-11-11 10:00 America/Toronto**. Twelve-hour evaluations and same-checkpoint publishing continue under the [authorized window](ai/guanzero/README.md#授权延长窗口).
Stage-zero match-objective analysis is documented in the [research index](ai/research/README.md) and study section 48. It reanalyses historical model 009, not new results for web champion 017. New training on this Windows machine is limited to danMCai.
The champion-start danMCai experiment completed 10,000 fresh heldout rounds. Its direct comparison with the original champion improved signed upgrade points; common-Clint and mixed-teammate contrasts remain inconclusive. See [grouped evidence and limitations](ai/research/MODEL_STUDY.md#467-最终学习器-10000-局独立留出完成). Web champion 017 is unchanged; experimental weights are not automatically published.

Stage 0.6 prepares a [zero-projection extras student](ai/research/ANALYSIS.md), retaining the champion backbone for numerical and browser equivalence checks. This is not online training, a strength improvement or a website promotion.

The next optional [danMCai experiment](ai/research/CONTINUOUS_TRAINING.md) tests a four-hour champion-only exploiter with fresh Adam, then separate held-out comparisons against 017, P0 and 012. This hypothesis does not imply improvement or authorize replacing the website champion.

The four-hour exploiter and its 10,000-round heldout are complete: no cheap target-specific signal was found. A new preregistered single-seat/fixed-teammate diagnostic uses fresh deals, with no training or website promotion. [Results and limits](ai/research/MODEL_STUDY.md#513-10000局留出完成本次未便宜找到剥削信号); [live progress](http://127.0.0.1:8767/).

The practice menu now includes a separate **open-hand endgame solver** with bounded computation, replay and local JSON export; it never trains a model or changes ordinary bot decisions. **Continue previous match** restores only between-round progress and anonymous match/seat IDs, preserving round numbering and private-tool collection exclusion. It does not restore unfinished hands or replace room reconnection. [Practice](web/docs/PRACTICE.md) · [Collection boundaries](web/collector/README.md).

The latest Clint UI adaptation adds an illustrated four-section rulebook, continuation inside level selection, delayed play controls during card collection, and deduplicated straight-flush hints. The six-item model menu and default champion017 remain unchanged. [Scope and verification](ai/research/MODEL_STUDY.md#54-clint增量规则书房主恢复与交互时序).

The 20,000-round single-seat/fixed-teammate diagnostic is complete; differences remain inconclusive. The next [champion017 cooperation grid](ai/research/MODEL_STUDY.md#55-冠军队友对手网格预登记) preregisters12,000 fresh deals,4,000 paired deals per cell and simultaneous interaction intervals. It evaluates final-round upgrade points without new training or website promotion.

The192,000-round [cooperation grid](ai/research/MODEL_STUDY.md#552-完成192000局未达到队友交互条件) is complete; no cell met the preregistered interaction condition. The next representation-corpus diagnostic uses only fixed champion017, without gradients, Clint/human training or website promotion.

The representation corpus completed 1,000,022 decisions from12,282 independent complete single rounds. Both nonplay slots occur in39.81% of all decisions and41.11% of choice decisions, exceeding the5% rarity condition. The next preregistered diagnostic fits only final-round G−Q statistical ridge probes on deal-held-out data and frozen hidden features: no tactical targets, neural updates, extras online training or website promotion. See research report sections56.2 and58.

The completed residual probe found extras-only R²0.00577 but partial R²0.01572 beyond the frozen hidden representation; the preregistered conservative closure condition is false. No neural updates or strength acceptance. Next is the first017 raw-argmax whole-match baseline, separately compared with the web policy:11,000 planned matches under a new two-hour protocol, CPU only, no training or promotion. See research report58.1/59.

The independent017 whole-match baseline completed11,000 matches/117,508 rounds. Raw vsClint match score is+0.6275,95%root-clusterCI[0.5960,0.6590]; comparisons with012 and web-minus-raw differences remain uncertain. Opponents and protocols remain separate. Next is a new200-root descriptive Q-gap study followed by6,000 fresh trajectory pairs, with no neural updates, calibrated liveTop5 or promotion. See research report59.2/60.

The decision corpus completed12,400 rounds (200 preliminary roots plus6,000 main pairs);1,049,781 actions replayed and707,735 neural choices matched recorded top1 indices. No neural updates or calibration claim. Next:10,000 fresh baseline/one-legal-deviation pairs with final-round upgrade differences and recorded importance weights; no calibrated UI export or champion change. See report60.3/61.

The10,000 final-outcome deviation pairs completed. Self beta0.738725[0.498932,0.977585] andClint0.665375[0.421155,0.919781] show positive signals but fail the preregistered Q-unit interval condition. Next is an offline self-only monotone fit with fresh-root numerical validation; Clint/mixed/P0 labels stay evaluation-only. No calibrated liveTop5, neural training or promotion. See report61.2/62.

The self-only offline fit completed with1,906 display-layer cases and a3,393-byte statistical map, with zero neural updates. Fresh4,000-root validation is running from frozen600cf4d until its original2026-11-08T05:32:22.062896Z deadline. Startup and completed-prefix audits passed; forecast improvement remains untested pending completion. No refit, sample expansion, calibrated live Top5 or champion publication follows. See MODEL_STUDY62.1 and coach-calibration-20261108 evidence.

Clint changes e7538a1→2b2a824 align phone name plates, preserve the hand area through the last card, land deal animations on visible player plates, update the lobby attribution and remove its collection blurb. The017 default, model preferences and all rule/neural policies remain unchanged. Following that sync, the owner explicitly requested local room/name collection too; both sites now attach those optional labels. Evidence: `ai/research/evaluation/clint-sync-20261108-0435.json`.

Owner-authorized local collection now snapshots the room and human nicknames at play start, with null computer names. Labels are cleaned and bounded as on Clint, retained in private raw records and excluded from prepared sample fields. Historical records remain unchanged; this does not authorize human-data training or a champion change.

Fresh4,000-root/8,000-round offline calibration validation did not establish lower error: both self/Clint primary intervals cross zero. The map stays offline with no refit or sample expansion. Next is the bounded simulated-self review CLI only: archived Q ranks plus descriptions, no new games, inference, human/D1 input, search, calibrated values or promotion. See MODEL_STUDY62.2/65.

The offline self-simulation review converter and integrity audit are complete (MODEL_STUDY65.1). Further training remains limited by existing gates/authorization; a new direction has been requested. Do not rerun completed studies or enter phase2 automatically. Original campaign deadline monitoring continues; full review data stay ignored locally.

2026-11-08: New owner authorization permits autonomous Windows danMCai training until Wednesday 10:00 Toronto, with compute stopping at 09:45. The public-extras versus zero-input two-seed experiment is in preparation, not a strength result. Web champion017, frozen runs and human-data isolation remain unchanged. See the model study section66.

Capacity correction: the original10k-roots/slot engineering pilot was stopped and preserved at1825updates, without a strength claim. Formalv2 uses50kroots/slot; input arms share new training roots within each training seed, while the two training-seed repeats are disjoint. No pilot weights, Adam or replay are inherited. Protocol changes remain in study66.1–66.2.

Formalv2 training has started from frozenc506a03, with the first arm registered13:36:24.535–17:36:24.535Z and actualGPUupdates verified. The four-arm queue advances automatically; only the first arm has started, and strength remains unevaluated. Dashboard8767 and the earlier15:00Z/14:45Z cutoff are active. See study66.3 and startup-v2 evidence.

The owner additionally permits training a new research champion and explicitly continuing future batches from it after preregistered gates, fullSHA provenance and independent evaluation. Current frozen arms, webchampion017/[017,012] and the Wednesday10:00 cutoff remain unchanged. No new champion has yet passed. See study66.4 and champion-authorization evidence.

ClintUIincrement2026-11-08: partner shuffle/cut hints sit below the nameplate, desktop/tablet side-seat follow-lead labels face the table, and horizontal group labels sit at the lower right. Muted badges are removed from plates; microphone controls and permissions remain. Phone hints center on the actual plate. Model menu/default017, collection, recovery and frozen training are preserved. See study63.1 for evidence.
