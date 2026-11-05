import { runtime } from '../app/runtime.js';
import { VERSION } from '../network/protocol.js';
import { botModel, botModelId, CLINT_RULE_ID } from '../ai/model-catalog.mjs';
import { captureDeal, captureStart, captureAction, completedRecord } from './record.mjs';
import { indexedStore, UploadQueue } from './outbox.mjs';
import config from './config.json' with { type: 'json' };

let queue;
function context() {
  return {
    mode: runtime.network.mode,
    practice: runtime.reviewMode,
    kind: new URLSearchParams(location.search).get('test') === '1' ? 'test' : 'game',
    humans: [...runtime.network.humans],
    version: VERSION,
    rules: runtime.rules,
    models: [0, 1, 2, 3].map((p) => {
      const id = botModelId(runtime.botModels?.[(p + runtime.network.off) % 4]);
      if (id === CLINT_RULE_ID) return { id, sha256: null, version: 'rules-v2' };
      const model = botModel(id);
      return { id, sha256: model.sha256, version: model.source?.version || id };
    }),
  };
}
export const collectDealt = () => captureDeal(runtime.game, context());
export const collectStarted = () => captureStart(runtime.game, context());
export const collectAction = (p, play, automatic) =>
  captureAction(runtime.game, p, play, { ...context(), automatic });
export function collectCompleted() {
  const record = completedRecord(runtime.game, context());
  if (record && queue) void queue.enqueue(record).catch(() => {});
}
export function initialize() {
  const status = document.querySelector('#collectionStatus');
  queue = new UploadQueue({
    store: indexedStore(globalThis.indexedDB),
    endpoint: config.endpoint,
    onStatus: ({ pending, storageFailed, saved }) => {
      status.hidden = !(
        pending ||
        (runtime.network.mode === 'host' && runtime.network.humans.size >= 2)
      );
      status.textContent = pending
        ? `牌谱待同步 ${pending} 局${storageFailed ? ' · 本机暂存不可用' : ''}`
        : config.endpoint
          ? saved
            ? '牌谱已同步'
            : '牌谱自动保存'
          : '牌谱仅本机暂存';
    },
  });
  addEventListener('online', () => void queue.flush());
  setInterval(() => void queue.flush(), 15000);
  void queue.flush();
}
