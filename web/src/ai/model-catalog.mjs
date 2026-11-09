import catalog from './model-catalog.json' with { type: 'json' };
import { SEARCH_BOT_V1, SEARCH_CORE_VERSION } from './search/constants.mjs';

/**
 * Menu policy (owner 2026-11-09): exactly four entries, see selectableModels. The former
 * 'champions-v1' menu (Clint, two GuanZero generations, P0, two champions, research bot) is
 * historical; its models stay archived in `models`.
 */
export const MENU_MODE = 'latest-v2';
export const CLINT_RULE_ID = 'clint-rule';
const RELEASE_ASSET =
  /^https:\/\/github\.com\/stevensun1005\/guandanai\/releases\/download\/[^/]+\/[\w.-]+\.onnx$/;
const sameParams = (a, b) =>
  !!a &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([key, v]) => a[key] === v);

/**
 * Canonical manifest of a search research bot: what its collection identity `sha256` digests
 * (SHA-256 of JSON.stringify of this object). Deliberately not the base ONNX SHA, so records can
 * never pass search decisions off as pure champion decisions.
 */
export function searchBotManifest(bot, base) {
  return {
    schema: 'danMCai-search-bot-v1',
    id: bot.id,
    kind: bot.kind,
    base: { id: base.id, sha256: base.sha256, version: base.source.version },
    belief: { sha256: bot.belief.sha256, featureVersion: bot.belief.featureVersion },
    search: { ...bot.search },
    core: SEARCH_CORE_VERSION,
  };
}

/** Research bots: search policies over a gated danMCai champion, never a trained model. */
function validateSearchBots(value) {
  const bots = value.searchBots ?? [];
  if (!Array.isArray(bots)) throw Error('Invalid search bots');
  const ids = new Set(value.models.map((m) => m.id)),
    files = new Set(value.models.map((m) => m.file));
  for (const bot of bots) {
    const base = value.models.find((m) => m.id === bot.base);
    if (
      !/^\d{3,}$/.test(bot.id) ||
      ids.has(bot.id) ||
      bot.kind !== 'belief-search' ||
      !base ||
      base.config.history ||
      base.config.extraFeatures ||
      !Number.isInteger(base.source?.champion?.gate) ||
      !/^belief-[\w-]+\.onnx$/.test(bot.belief?.file) ||
      files.has(bot.belief.file) ||
      !/^[a-f0-9]{64}$/.test(bot.belief.sha256) ||
      !RELEASE_ASSET.test(bot.belief.url) ||
      bot.belief.featureVersion !== 'belief-v1' ||
      !/^[a-f0-9]{64}$/.test(bot.sha256) ||
      typeof bot.version !== 'string' ||
      !/^[\w.-]{1,80}$/.test(bot.version) ||
      !sameParams(bot.search, SEARCH_BOT_V1) ||
      value.defaultId === bot.id
    )
      throw Error('Invalid or duplicate search bot entry');
    ids.add(bot.id);
    files.add(bot.belief.file);
  }
}

export function validateCatalog(value) {
  if (value?.schema !== 1 || !Array.isArray(value.models) || !value.models.length)
    throw Error('Invalid model catalog');
  const ids = new Set(),
    files = new Set();
  for (const model of value.models) {
    if (
      !/^\d{3,}$/.test(model.id) ||
      ids.has(model.id) ||
      !/^[\w-]+\.onnx$/.test(model.file) ||
      files.has(model.file) ||
      !/^[a-f0-9]{64}$/.test(model.sha256) ||
      model.config?.stateFeatures !== 513 ||
      model.config?.actionFeatures !== 54 ||
      (model.config.extraFeatures && ![53, 61].includes(model.config.extraFeatures)) ||
      (model.config.history && model.config.history !== 'guanzero-v1')
    )
      throw Error('Invalid or duplicate model entry');
    if (model.url && !RELEASE_ASSET.test(model.url))
      throw Error('Model must use a pinned repository Release asset');
    ids.add(model.id);
    files.add(model.file);
  }
  if (!ids.has(value.defaultId)) throw Error('Missing default model');
  if (value.selection) {
    // danMCaiChampions: the last two gated champions, current first. Only [0] is in the menu;
    // [1] stays as the champion record that tooling and gate-evidence checks read.
    const champions = value.selection.danMCaiChampions;
    if (
      value.selection.mode !== MENU_MODE ||
      !Array.isArray(champions) ||
      champions.length !== 2 ||
      new Set(champions).size !== 2 ||
      champions.some((id) => {
        const model = value.models.find((m) => m.id === id);
        return !model || model.config.history || !Number.isInteger(model.source?.champion?.gate);
      }) ||
      value.defaultId !== champions[0]
    )
      throw Error('Invalid champion selection');
  }
  validateSearchBots(value);
  validateDefaultChoice(value);
  return value;
}

/**
 * Menu default for new players and empty seats (`selection.defaultChoice`). `defaultId` stays the
 * current danMCai champion's neural weights (Top 5, tribute, private table, champion tooling). The
 * menu default may differ only by naming a search bot built on that same current champion, so a
 * champion change must decide the menu default again instead of silently keeping an old base.
 */
function validateDefaultChoice(value) {
  const choice = value.selection?.defaultChoice;
  if (choice === undefined) return;
  const bot = (value.searchBots ?? []).find((b) => b.id === choice);
  if (
    (choice !== value.defaultId && bot?.base !== value.selection.danMCaiChampions[0]) ||
    !selectableModels(value).some((entry) => entry.id === choice)
  )
    throw Error('Invalid menu default');
}

validateCatalog(catalog);
export const BOT_MODELS = Object.freeze(catalog.models.map((model) => Object.freeze(model)));
/** Current champion's neural weights; the menu default below may be a search bot over it. */
export const NEURAL_DEFAULT_MODEL = catalog.defaultId;
/** What a new player's computer seats use, and where unknown or retired choices fall back. */
export const DEFAULT_BOT_MODEL = catalog.selection?.defaultChoice ?? catalog.defaultId;
export const SEARCH_BOTS = Object.freeze(
  (catalog.searchBots || []).map((bot) => Object.freeze(bot)),
);
/** The search research bot of `value`, or null (for every neural model and Clint). */
export const searchBot = (value) => SEARCH_BOTS.find((bot) => bot.id === value) || null;
export const botModelId = (value) =>
  value === CLINT_RULE_ID ||
  BOT_MODELS.some((model) => model.id === value) ||
  SEARCH_BOTS.some((bot) => bot.id === value)
    ? value
    : DEFAULT_BOT_MODEL;
/** Neural weights a seat uses; a search bot uses its base champion's (tribute, fallback, Top 5). */
export const botModel = (value) => {
  if (value === CLINT_RULE_ID) throw Error('Clint rules do not use a neural model');
  const id = botModelId(value);
  const base = searchBot(id)?.base ?? id;
  return BOT_MODELS.find((model) => model.id === base);
};
/** Collection identity {id, sha256, version} of a seat's bot. */
export const botIdentity = (value) => {
  const id = botModelId(value);
  if (id === CLINT_RULE_ID) return { id, sha256: null, version: 'rules-v2' };
  const bot = searchBot(id);
  if (bot) return { id, sha256: bot.sha256, version: bot.version };
  const model = botModel(id);
  return { id, sha256: model.sha256, version: model.source?.version || id };
};
export const botModelName = (value) => {
  if (value === CLINT_RULE_ID) return 'Clint规则机器人';
  // danMCai-reason-v<champion version>: the reasoning (belief-search) bot over that champion
  if (searchBot(value)) return 'danMCai-reason-' + botModel(searchBot(value).base).source.version;
  const model = botModel(value);
  if (model.config.history === 'guanzero-v1' && model.source?.run) {
    const checkpoint = Number.isSafeInteger(model.source.step)
      ? `${model.source.step}`
      : model.source.version;
    return checkpoint ? `${model.source.run}-${checkpoint}` : model.source.run;
  }
  return (
    'danMCai-' + (model.source?.version === 'P0' ? 'v000000000' : model.source?.version || model.id)
  );
};

/**
 * The computer-model menu, in this order: Clint rules (rules-v2); the newest registered GuanZero
 * generation; the current gated danMCai champion (danMCaiChampions[0]); the newest reasoning bot
 * over that champion (danMCai-reason). Everything else stays archived and is never offered.
 */
export function selectableModels(value) {
  const models = value.models;
  if (!value.selection) return models;
  const champion = value.selection.danMCaiChampions[0];
  return [
    { id: CLINT_RULE_ID, kind: 'rule' },
    models.filter((m) => m.config.history === 'guanzero-v1').at(-1),
    models.find((m) => m.id === champion),
    (value.searchBots || []).filter((bot) => bot.base === champion).at(-1),
  ].filter(Boolean);
}
export const BOT_CHOICES = Object.freeze(selectableModels(catalog));
export const botChoiceId = (value) =>
  BOT_CHOICES.some((m) => m.id === value) ? value : DEFAULT_BOT_MODEL;
