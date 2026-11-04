import { runtime } from '../app/runtime.js';
import { selectionFeedback } from '../hand/selection-feedback.js';
import { $ } from './cards.js';

export function renderSelectionStatus(options) {
  const game = runtime.game;
  const row = $('#selectionBar');
  row.hidden =
    runtime.reviewMode ||
    !game?.hands[0]?.length ||
    !['prep', 'play', 'return', 'tribPick'].includes(game.phase);
  if (row.hidden) return;
  const cards = game.hands[0].filter((card) => runtime.selection.has(card.id));
  const feedback = selectionFeedback(cards, game.L, options);
  const status = $('#selectionStatus');
  if (status.textContent !== feedback.message) status.textContent = feedback.message;
  status.dataset.tone = feedback.tone;
  $('#selectionClear').hidden = !feedback.count;
}

export function initialize(clear) {
  $('#selectionClear').onclick = clear;
}
