import { $ } from './cards.js';

export const isFullscreen = () =>
  !!(document.fullscreenElement || document.webkitFullscreenElement);

export function syncFullscreen() {
  const active = isFullscreen();
  $('#fsBtn').textContent = active ? '退出全屏' : '全屏';
  document.body.classList.toggle('fs', active);
  $('#fsOptBtn').textContent = active ? '退出全屏' : '全屏';
  $('#fsOptBtn').setAttribute('aria-pressed', active);
}

export function toggleFullscreen() {
  try {
    const root = document.documentElement;
    const request = isFullscreen()
      ? (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
      : (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root);
    request?.catch?.(() => {});
  } catch (_) {}
}

export function initialize() {
  $('#fsOptBtn').hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  $('#fsOptBtn').onclick = toggleFullscreen;
  $('#fsBtn').onclick = toggleFullscreen;
  for (const event of ['fullscreenchange', 'webkitfullscreenchange'])
    document.addEventListener(event, syncFullscreen);
  syncFullscreen();
}
