<div align="center">

Owner-clarified cutoff: Nov13 05:00Toronto training stop, 08:00 evaluation cutoff, then summary/packaging. Eight actors use DML for large candidate batches; all outcomes are reported, while deployment remains conditional. [Amendment](ai/research/evaluation/endgame-rebase-029-20261112/owner-8am/protocol.json).

The owner authorized automatic packaging and web release only after complete independent improvement gates and compatibility checks. Training is still active; no new student improvement is established. [Conditional release](ai/research/evaluation/endgame-rebase-029-20261112/conditional-release/authorization.json).

Windows metadata locks were addressed with an archived stop and a new frozen runtime. Recovery keeps the matched checkpoint/Adam and original deadlines; it is not evidence of stronger play. [Recovery amendment2](ai/research/evaluation/endgame-rebase-029-20261112/runtime-note-2.json).

The029-based endgame delta-transfer run is now active on Windows with actual new GPU updates, separate from its two synthetic checks. Training stops Nov13 at03:58Toronto; final/initial/r2 paired evaluation follows without automatic student deployment. [Actual startup](ai/research/evaluation/endgame-rebase-029-20261112/startup.json).

The [029-based endgame transfer experiment](ai/research/evaluation/endgame-rebase-029-20261112/protocol.design.json) adds the r2-minus017 trunk delta to029 with fresh Adam. This is an experimental initialization, not exact optimizer resumption or evidence of improved play. Preparation, GPU checks, actual training and held-out evaluation are recorded separately. Web029 is live with verified SHA and menu/default.

2026-11-12: the owner authorized publishing **danMCai-v000061013 (029)** as the neural champion/default. Until a search bot on this base is independently validated, the existing menu rule offers Clint, the latest GuanZero and029. Old017/9001 remain archived. The raw017 gate passed, but a separate2,000-round comparison against old017-basedreason gave−.195 signed points per pair (95%CI−.27035 to−.11965); this is not universal superiority. [Release evidence](ai/research/evaluation/web-champion-029-20261112/champion.json).

# GuandanAI

[简体中文](./README.md) · English

### A table for friends. One link to play.

Four-player GuanDan with bots running in your browser, private rooms and practical hand tools. Works on desktop and phone.

[![Deploy](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml/badge.svg)](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml)
[![Version](https://img.shields.io/github/package-json/v/stevensun1005/guandanai?color=ddb050)](./CHANGELOG.md)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-f7df1e?logo=javascript&logoColor=black)
![Runtime](https://img.shields.io/badge/Runtime-Browser_%2B_WebAssembly-4a7c59)

**[Play now](https://stevensun1005.github.io/guandanai/) · [Playing guide](./web/docs/PLAYING.md) · [Download a release](https://github.com/stevensun1005/guandanai/releases/latest) · [Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md)**

</div>

![An actual game](./web/docs/media/table-desktop.png)

<details>
<summary>More views: mobile help and match history</summary>

<p align="center"><img src="./web/docs/media/help-mobile.png" width="280" alt="Mobile controls guide" /> <img src="./web/docs/media/match-history-mobile.png" width="280" alt="Match results and public scorecard on mobile" /></p>

</details>

## Bring your friends

1. Enter a nickname and create a room.
2. Pick a seat and copy the invitation link.
3. Friends open the link and take their seats. The host starts the game.

Empty seats are filled by bots. Play alone or with up to three friends. The host runs the table and computes bot turns. Within three hours, reopening the same build in the same browser can restore the original room after a refresh or closed tab; friends reclaim their original seat credentials. Explicit exit clears this local recovery. See [rooms and recovery](./web/docs/ROOMS.md).

Use the lobby’s start-settings dialog to set each team’s level, the active team, the previous finishing order and failed A attempts. Desktop/tablet name plates are symmetric, card backs can be hidden, and rotation/fullscreen changes reflow without rewriting the viewport. The final-chance option gives the other team one A attempt after a team has exhausted three; the table shows A1/A2/A3 or A末. Straight-flush selection counts combinations and clears the selection after a full cycle. See the [playing guide](./web/docs/PLAYING.md).

Spectate a room from the lobby using its four-digit code. Spectators receive public plays and hand counts, take no seat and cannot act; the host can manage spectator voice from Options. [Spectator guide](web/docs/PLAYING.md#观战朋友的牌桌)

## What is included

| Feature             | In the game                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Four-player GuanDan | Two decks, wild cards, bombs, tribute, partner lead and level progression                                                                                                                                                                              |
| Friend rooms        | Invitations, seat selection, spectating, temporary bot takeover and original-tab recovery                                                                                                                                                              |
| Browser bots        | A rules bot, versioned trained models and an inference-search bot, all computed in a browser Web Worker                                                                                                                                                |
| Hand tools          | Dragging, sweeping, manual groups, one-tap restore, smart/rank/suit ordering and 30-step arrangement undo/redo                                                                                                                                         |
| Clear actions       | Selection feedback, keyboard navigation, optional play confirmation and optional move feedback                                                                                                                                                         |
| Table emotes        | Five presets (cappuccino, flower and bomb thrown at a seat; sunglasses, crying) with effects, spoken small-talk phrases (no play signals), from a round button at the bottom right, next to the sort button; computer seats answer gifts; no free text |
| Public scorecards   | Select earlier rounds, filter public actions and export a round or the match                                                                                                                                                                           |
| Static deployment   | GitHub Pages; no inference server or API key required                                                                                                                                                                                                  |

The in-game scorecard keeps earlier rounds, finishing orders and public action totals throughout the match. Switch rounds, filter players or download the whole public match log; held cards are excluded. Completed rounds also travel with seat recovery.

**[Training](./web/docs/PRACTICE.md)** in the lobby starts with arrangement, full-table or endgame practice. Arrangement practice compares reference groups with your edits for each seat; the face-up table keeps all four hands visible with per-move notes and replay; the endgame mode offers a separate open-hand solver with stop, replay and local export. The grouping score is not a neural probability or win rate, and practice records are not automatically used for training.

The practice table keeps its action grid in one place, including after your hand is empty. Played cards stay readable in a scrollable area, while notes and round results sit in the lower-left corner.

**Optional move feedback:** once the host permits it, each player can opt in. A Top 5 panel shows actual cards and relative scores (from the reasoning search once 40 or fewer cards remain on the table, otherwise from the champion); clicking selects cards without playing them, and percentages are not win probabilities. See [move feedback](web/docs/MOVE_COACH.md).

## Built for the browser

Players do not need Node.js, Python or a desktop client. After the page loads, bot moves are computed in the host’s browser with a Web Worker and WebAssembly. Models receive only their own hand, public plays, card counts and levels. See the [model training guide](./ai/research/MODEL_TRAINING.md) for training history and scope.

Inference components and models download only when this browser needs to run a bot; guests joining a friend’s room do not wait for model loading. Loading failures offer a retry instead of silently switching to a different bot policy.

Completed multiplayer rounds with at least two human seats are collected by the host into private cloud storage. Records include the room number and human seat nicknames at play start (computer names are null), and omit chat, voice and seat credentials; offline retries and deduplication are supported. Private JSON/JSONL exports remain isolated research data and are not automatically fed into active training. Rounds from [Clint's site](https://clintsun1977.github.io/guandan/) are uploaded to the same store in the same format (`appVersion` starting with `c1977`). See [collection and export](./web/collector/README.md).

## Models and research

The computer-model menu has exactly four entries: the Clint rules bot, the latest GuanZero generation, the current danMCai gate champion (danMCai-v000855042) and the reasoning bot **danMCai-reason-v000855042**. **Both the default bot and move feedback use danMCai-reason-v000855042 (id 9001)**, chosen by the owner on 2026-11-09. It builds on champion 017: the hand-inference network v1 estimates the other three hands from public information only, and the bot searches candidate plays across sampled worlds in the midgame and endgame; on a timeout or error it plays 017’s move. It is not a newly trained champion; tribute still uses 017. danMCai P0, the previous champion and older GuanZero generations have left the menu (weights and records stay archived); saved choices of them revert to the default.

Validation scope: +0.237 [0.208, 0.266] per deal pair in an offline held-out test against champion-017 opponents only, single rounds without tribute. Play against humans, mixed teams and tribute rounds is untested, so its web strength cannot be quoted as that number.

[Model selection and publishing](./web/docs/WEB_MODELS.md) · [Bot design](./web/docs/BOTS.md) · [Model research report](./ai/research/MODEL_STUDY.md) · [Research progress log](./ai/research/PROGRESS_LOG.md)

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
npm test              # rules, input validation, model features and module boundaries
npm run format:check  # code and documentation formatting
npm run build         # full production build
```

Python is a developer tool for model export, training and browser validation. Players and the static build do not need it. Tested Python dependencies are recorded in `ai/environment/requirements-dev.txt` and `ai/environment/requirements-models.txt`. See [contributing](./CONTRIBUTING.md) and [testing](./web/docs/TESTING.md).

Validation includes three viewport sizes, numerical checks for both models, recovery races and three complete automated matches: **37 rounds and 2,957 actions** across two- and four-client sessions. See the [validation scope and reports](./web/docs/TESTING.md).

## A project with clear boundaries

```text
web/                      Web application
  src/                    Game, UI, rooms and browser inference
  tools/                  Build, preview and packaging
  tests/                  Web and browser tests
  docs/                   Playing, controls and deployment
ai/                       AI
  danMCai/                danMCai training, data, evaluation and weights
  guanzero/               Separate GuanZero training and evaluation
  shared/                 Shared simulation and fixed positions
  research/               Research, handoff and experiment evidence
  publishing/             Browser model publishing and archival
  environment/            Python dependency lists
```

Production assets are bundled into `web/dist/`; edit `web/src/`, not the build output. Rules do not depend on DOM or session state. Model observations are explicitly limited to the acting player's hand and public information. See the [architecture guide](./web/docs/ARCHITECTURE.md).

**[Web application](web/README.md) · [AI](ai/README.md) · [danMCai](ai/danMCai/README.md) · [GuanZero](ai/guanzero/README.md)**. Each directory README maps files, run data and research records; see the [migration guide](ai/research/STRUCTURE_MIGRATION.md) for old paths.

## Publish

Pull requests run unit checks, formatting, the build and real browser play/import smoke tests without deploying. Push to `main` to deploy after those checks pass. Documentation and experimental checkpoint archival pushes do not trigger deployment. Configure Pages to use **GitHub Actions** as its source. All inference resources are included in the static deployment.

You can also upload the whole `web/dist` directory produced by `npm run build` to any static host. Keep `assets/` and `models/` at their relative locations; the application uses relative asset URLs and supports repository subpaths. See the [deployment guide](./web/docs/DEPLOYMENT.md).

## FAQ

**Can a friend come back after a refresh?** Yes. A guest can refresh the original browser tab or reconnect after a data-channel interruption. The host verifies the original seat credential, sends its current snapshot and cancels any unfinished bot turn for the returning player. If an incoming event queue stops advancing, the guest can resynchronize on the existing connection without extending the host’s turn clock.

**Can the host close the page?** The host page runs the table. Recovery is tab-local; it does not provide account-based or cross-device sign-in. If the host leaves, guests can continue independently against bots running in their own browser; automatic host migration is not implemented.

**Why can’t a friend connect sometimes?** Rooms use WebRTC with public PeerJS signaling, so both networks, NAT and firewalls matter. A page-version mismatch blocks starting the table; refresh both sides to the same build and retry.

**Why does a bot sometimes think for a few seconds?** The default inference-search bot runs a multi-world search in the midgame and endgame. It usually finishes in under a second. Like a human, a bot has at most 60 seconds per move: it reasons until at most 50 seconds after its turn starts (on every device, the thinking pause and first load included) and keeps 10 seconds for the fallback, champion 017’s move. Clint’s endgame brain follows the same rule (at most 30 seconds and never past the 50-second mark; otherwise it plays its rules-only move). A fallback never sticks: the next move reasons again. See [bot design](./web/docs/BOTS.md).

**Do the bots peek at other hands?** No. Model and search inputs contain only the acting seat’s hand and public information. The host browser holds the full table state, which is separate from what the models receive.

**Which devices are supported?** Validation covers desktop Chrome, simulated phone layouts, multiple browser contexts, full rounds, tribute and recovery races. Different physical devices and networks still need broader long-running playtests. See [testing](./web/docs/TESTING.md) and [room recovery](./web/docs/ROOMS.md).

## Improve one hand at a time

For a useful [issue](https://github.com/stevensun1005/guandanai/issues), include the device, browser, page version and steps. Rule or bot issues benefit from a concrete hand and the public actions leading to it. UI changes benefit from screenshots.

[Contributing](./CONTRIBUTING.md) · [Bot design](./web/docs/BOTS.md) · [Model training](./ai/research/MODEL_TRAINING.md) · [Testing](./web/docs/TESTING.md)

## Documentation

| Task                                  | Start here                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play, arrange cards or replay         | [Playing](./web/docs/PLAYING.md) · [Practice](./web/docs/PRACTICE.md) · [Move feedback](./web/docs/MOVE_COACH.md)                                                                                                                      |
| Invite friends or recover a seat      | [Rooms](./web/docs/ROOMS.md)                                                                                                                                                                                                           |
| Develop, validate or deploy           | [Contributing](./CONTRIBUTING.md) · [Architecture](./web/docs/ARCHITECTURE.md) · [Testing](./web/docs/TESTING.md) · [Deployment](./web/docs/DEPLOYMENT.md)                                                                             |
| Understand bots or reproduce training | [Bots](./web/docs/BOTS.md) · [Model selection](./web/docs/WEB_MODELS.md) · [Training entry points](./ai/research/MODEL_TRAINING.md) · [Historical training log](./ai/research/TRAINING_RUN.md)                                         |
| Review evidence and planned work      | [Research report](./ai/research/MODEL_STUDY.md) · [Research progress log](./ai/research/PROGRESS_LOG.md) · [Improvement proposals and implementation status](./ai/research/IMPROVEMENT_PROPOSAL.md) · [Roadmap](./web/docs/ROADMAP.md) |

Scheduled GuanZero development evaluation now uses the accepted danMCai champion (500 complete matches) and danMCai-reason (200): 250/100 swapped-team pairs,700 matches total. Clint is retired from evaluation. Historical reports retain their registered protocols; publish the identical evaluated weights only after required reports finish. See the [protocol](ai/guanzero/README.md#danmcai-reason评测协议).

### Windows extras window closeout (2026-11-11)

Four four-hour training arms finished with 472,461 new optimizer updates. Independent heldout evaluation completed zero rounds, and subsequent training was not started: no new research champion was established, and continuous training through Wednesday was not fulfilled. Read-only final-network/13-state Adam/replay/215-source audits passed again. The 14:45Z STOP and 15:00Z temporary-awake release were verified; only the expired windows-a-b follow-up was deleted, preserving ai/clint-ui. No deadline extension or website catalog change. Full hashes, counts and limitations: [closeout evidence](ai/research/evaluation/extras-input-ablation-20261108/closeout-20261111.json); study66.5 preserves the original plan and missing work.

### Clint interface and room update (2026-11-11 Eastern)

The lobby aligns the nickname, mode and rule controls and adds a footer photo; horizontal group labels share the longest group's upper-right edge. Hosts can choose30/60/90-second sorting and20+60/30+60/60-second play: +60 is a human player's shared overtime reserve for the whole round, retained on recovery and reset next round; computers use only base move time. Pause panels expose the microphone and host-only resume, signaling reconnects, and unanswered joins/watches time out after15 seconds. Public spectators may use another page version; seated players still require matching versions. Short hands auto-pass only when no legal reply including bombs exists, tagged automatic. Host restoration, permissions, raw collection and the four-model menu/default remain. Strategy changes stay in Clint rules-v2; historical win rates remain tied to old fingerprints. [Guide and evidence](web/docs/PLAYING.md#clint界面与房间更新2026-11-11美东)

[Overnight research-champion window](ai/research/evaluation/overnight-champion-20261112/protocol.design.json)：New owner authorization: Windows danMCai only, until Nov12 09:00 Toronto (08:45 compute cutoff),7h training then automatic final-only independent gate. Archived windows stay closed; no new champion or website publication claimed.

Research champion v000061013 passed its preregistered10000-round gate: +.0990 upgrade points against017,95%CI[.0250,.1730]. Website remains017/reason9001; no full-match or human claim. [结果与范围](ai/research/evaluation/overnight-champion-20261112/heldout-results.json)。

[新冠军与reason评测](ai/research/evaluation/champion-vs-reason-20261112/protocol.design.json)：Preregistered2000-round comparison: newrawresearchchampion versus deployed017-basedreason. Evaluation only; no results or website changes yet.

Evaluation v2 uses fresh1000 deals,twoCPUworkers and coldper-roundsolver caches within the original12:30Toronto cutoff. The212-roundv1memorypilot is preserved as partial engineering evidence. [v2](ai/research/evaluation/champion-vs-reason-20261112/v2/protocol.design.json)。

The memory-bounded reason comparison v2 started at 14:46:43Z with two workers and fresh deals, within the original 17:30:48Z cutoff. This is evaluation only; no final conclusion yet. [Startup evidence](ai/research/evaluation/champion-vs-reason-20261112/v2/startup.json).

The08:00 endgame window ended (complete); complete, partial and negative evidence is preserved. Conditional release is not accepted; current model retained. [Closeout](ai/research/evaluation/endgame-rebase-029-20261112/closeout-8am/results.json).
