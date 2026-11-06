import './styles/index.css';
import * as viewport from './ui/viewport.js';
import * as policyController from './ai/controller.js';
import * as cards from './core/cards.js';
import * as combinations from './core/combinations.js';
import * as moves from './core/moves.js';
import * as handValue from './ai/hand-value.js';
import * as arrangement from './hand/arrangement.js';
import * as rulePolicy from './ai/rule-policy.js';
import * as handHints from './hand/hints.js';
import * as session from './game/session.js';
import * as dealing from './game/dealing.js';
import * as tribute from './game/tribute.js';
import * as turns from './game/turns.js';
import * as clock from './game/clock.js';
import * as clockView from './ui/clocks.js';
import * as followHints from './hand/follow-hints.js';
import * as round from './game/round.js';
import * as playerActions from './input/actions.js';
import * as events from './game/events.js';
import * as cardView from './ui/cards.js';
import * as tablePile from './ui/table-pile.js';
import * as tableView from './ui/table.js';
import * as handView from './hand/view.js';
import * as handTools from './hand/tools.js';
import * as handLayout from './hand/layout.js';
import * as deckEffects from './effects/deck.js';
import * as dealingEffects from './effects/dealing.js';
import * as sound from './audio/sound.js';
import * as celebrations from './effects/celebrations.js';
import * as overlays from './ui/overlays.js';
import * as pointer from './input/pointer.js';
import * as controls from './input/controls.js';
import * as handKeyboard from './input/hand-keyboard.js';
import * as selectionStatus from './ui/selection-status.js';
import * as publicHistory from './ui/history-dialog.js';
import * as rulesDialog from './ui/rules-dialog.js';
import * as lobby from './lobby/lobby.js';
import * as practice from './lobby/practice.js';
import * as fullscreen from './ui/fullscreen.js';
import * as botSetup from './lobby/bot-setup.js';
import * as botProfiles from './ai/profiles.js';
import * as replaySession from './replay/session.js';
import * as replayStorage from './replay/storage.js';
import * as replayInspector from './replay/inspector.js';
import * as replayHistory from './replay/history.js';
import * as replayViewer from './replay/viewer.js';
import * as replayExport from './replay/import-export.js';
import * as protocol from './network/protocol.js';
import * as voice from './network/voice.js';
import * as rooms from './network/rooms.js';
import * as recovery from './network/recovery.js';
import * as startup from './app/startup.js';
import { runtime } from './app/runtime.js';
import * as collection from './collection/client.js';
import * as collectionRecord from './collection/record.mjs';
import * as coach from './coach/controller.js';
import * as privateTable from './private-table/controller.js';
import * as emotes from './social/controller.js';

policyController.initialize();
handValue.initialize();
arrangement.initialize();
rulePolicy.initialize();
handHints.initialize();
session.initialize();
dealing.initialize();
tribute.initialize();
turns.initialize();
clock.initialize();
round.initialize();
playerActions.initialize();
events.initialize();
cardView.initialize();
tablePile.initialize();
tableView.initialize();
handView.initialize();
handLayout.initialize();
deckEffects.initialize();
dealingEffects.initialize();
sound.initialize();
celebrations.initialize();
overlays.initialize();
pointer.initialize();
controls.initialize();
emotes.initialize();
handKeyboard.initialize();
selectionStatus.initialize(controls.clearPicked);
publicHistory.initialize();
rulesDialog.initialize();
fullscreen.initialize();
handTools.initialize();
lobby.initialize();
botSetup.initialize();
replaySession.initialize();
practice.initialize();
replayStorage.initialize();
replayInspector.initialize();
replayHistory.initialize();
replayViewer.initialize();
replayExport.initialize();
protocol.initialize();
voice.initialize();
rooms.initialize();
recovery.initialize();
collection.initialize();
coach.initialize();
privateTable.initialize();
startup.initialize();
viewport.initialize();

if (new URLSearchParams(location.search).get('test') === '1') {
  const features = [
    coach,
    collection,
    collectionRecord,
    privateTable,
    policyController,
    cards,
    combinations,
    moves,
    handValue,
    arrangement,
    rulePolicy,
    handHints,
    session,
    dealing,
    tribute,
    turns,
    clock,
    clockView,
    followHints,
    round,
    playerActions,
    events,
    cardView,
    tablePile,
    tableView,
    handView,
    handLayout,
    deckEffects,
    dealingEffects,
    sound,
    celebrations,
    overlays,
    pointer,
    controls,
    lobby,
    botSetup,
    botProfiles,
    replaySession,
    replayStorage,
    replayInspector,
    replayHistory,
    replayViewer,
    replayExport,
    protocol,
    voice,
    rooms,
    startup,
  ];
  const values = Object.assign({}, ...features);
  for (const [key, value] of Object.entries(values))
    if (key !== 'initialize')
      Object.defineProperty(window, key, { value, writable: true, configurable: true });
  const aliases = {
    NAMES: 'names',
    armCache: 'armCache',
    G: 'game',
    sel: 'selection',
    TEST: 'reviewMode',
    TV: 'replayView',
    NET: 'network',
    RULES: 'rules',
    hints: 'hints',
    hintIdx: 'hintIdx',
    msgTimer: 'msgTimer',
    lastTick: 'lastTick',
    confirmPlay: 'confirmPlay',
    cfm: 'confirmation',
    miniPlays: 'miniPlays',
    pileZ: 'pileZ',
    heapZ: 'heapZ',
    phoneRefitAsked: 'phoneRefitAsked',
    pileGroups: 'pileGroups',
    TS: 'TS',
    TRIBUI: 'TRIBUI',
    handView: 'handView',
    handRows: 'handRows',
    flatRows: 'flatRows',
    flatShown: 'flatShown',
    flatOneFits: 'flatOneFits',
    colW: 'colW',
    fixPeak: 'fixPeak',
    ROW_STEP: 'ROW_STEP',
    CR: 'CR',
    fxCut: 'fxCut',
    lastDown: 'lastDown',
    mv: 'mv',
    sweep: 'sweep',
    sfIdx: 'sfIdx',
    cardBack: 'cardBack',
    resizeT: 'resizeT',
    handW: 'handW',
    myNick: 'nickname',
    myDir: 'direction',
    lobbyMode: 'lobbyMode',
    botStyles: 'botStyles',
    botModels: 'botModels',
    TREC: 'TREC',
    practiceWH: 'practiceWH',
    TSEL: 'TSEL',
    TSFI: 'TSFI',
    storeT: 'storeT',
    miniRect: 'miniRect',
    TSNAP: 'TSNAP',
  };
  for (const [name, key] of Object.entries(aliases))
    Object.defineProperty(window, name, {
      get: () => runtime[key],
      set: (value) => {
        runtime[key] = value;
      },
      configurable: true,
    });
}
