import { runtime } from '../app/runtime.js';
import { toggleCardSelection } from './pointer.js';
import { $ } from '../ui/cards.js';

export function initialize() {
  $('#hand').addEventListener('focusin', (event) => {
    const card = event.target.closest('.card');
    if (card)
      for (const element of $('#hand').querySelectorAll('.card'))
        element.tabIndex = element === card ? 0 : -1;
  });
  $('#hand').addEventListener('keydown', (event) => {
    const card = event.target.closest('.card');
    if (!card || !['prep', 'play', 'return', 'tribPick'].includes(runtime.game?.phase)) return;
    const cards = [...$('#hand').querySelectorAll('.card')];
    const current = cards.indexOf(card);
    let next = current;
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(cards.length - 1, current + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = cards.length - 1;
    else if (event.key === ' ' || event.key === 'Enter') toggleCardSelection(+card.dataset.id);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== current) {
      cards.forEach((element, index) => {
        element.tabIndex = index === next ? 0 : -1;
      });
      cards[next].focus({ preventScroll: true });
    }
  });
}
