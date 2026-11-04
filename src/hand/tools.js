import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { armPlaysRaw } from './arrangement.js';
import { canUndoOrder, changeOrder, normalizeOrder, sortActive, undoOrder } from './ordering.js';
import { renderHand, vertMode } from './view.js';
import { syncHandBtns } from '../input/controls.js';
import { $ } from '../ui/cards.js';
import { setMsg } from '../ui/table.js';

function closeTools(focus = false) {
  $('#handToolsMenu').hidden = true;
  $('#sortBtn').setAttribute('aria-expanded', 'false');
  if (focus) $('#sortBtn').focus();
}

export function undoHandOrder() {
  if (!runtime.game || runtime.reviewMode || !undoOrder(runtime.game)) return;
  runtime.selection.clear();
  renderHand();
  setMsg('已撤销上次理牌');
}

function applyTool(mode) {
  const game = runtime.game;
  if (!game?.hands[0]?.length) return;
  if (mode === 'undo') {
    undoHandOrder();
    return;
  }
  changeOrder(game, () => {
    if (mode === 'release') {
      Object.assign(game, sortActive(game.hands[0], { fixed: [], myOrder: [] }, game.L));
    } else if (mode === 'smart') {
      const order = normalizeOrder(game.hands[0], game, game.L);
      const fixed = new Set(order.fixed.flat());
      const active = game.hands[0].filter((card) => !fixed.has(card.id));
      const units = armPlaysRaw(active, game.L);
      game.myOrder = units.flatMap((unit) => unit.cards.map((card) => card.id));
    } else Object.assign(game, sortActive(game.hands[0], game, game.L, mode));
  });
  if (vertMode() && mode !== 'rank') {
    runtime.handView = 'flat';
    try {
      localStorage.setItem('guandan-view', 'flat');
    } catch (_) {}
    syncHandBtns();
  }
  runtime.selection.clear();
  renderHand();
  Sound.play('shuffle');
  setMsg(
    {
      rank: '散牌已按大小排列，成组保留',
      suit: '散牌已按花色排列，成组保留',
      smart: '散牌已按牌型排好，成组保留',
      release: '已拆开所有成组，按大小排列',
    }[mode],
  );
}

export function toggleHandTools() {
  const menu = $('#handToolsMenu');
  if (!menu.hidden) {
    closeTools();
    return;
  }
  if (!runtime.game?.hands[0]?.length) return;
  $('#handUndoOrder').disabled = !canUndoOrder(runtime.game);
  $('#handReleaseGroups').disabled = !runtime.game.fixed?.length;
  menu.hidden = false;
  const anchor = $('#sortBtn').getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  menu.style.left =
    Math.max(8, Math.min(anchor.right - rect.width, innerWidth - rect.width - 8)) + 'px';
  menu.style.top =
    Math.max(8, Math.min(anchor.top - rect.height - 8, innerHeight - rect.height - 8)) + 'px';
  $('#sortBtn').setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
}

export function initialize() {
  const menu = $('#handToolsMenu');
  menu.addEventListener('click', (event) => {
    const action = event.target.closest('[data-hand-tool]');
    if (!action || action.disabled) return;
    applyTool(action.dataset.handTool);
    closeTools(true);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#handToolsMenu,#sortBtn')) closeTools();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      closeTools(true);
    }
  });
  addEventListener('resize', () => closeTools());
}
