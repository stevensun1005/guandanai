import catalog from './model-catalog.json' with { type: 'json' };

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
    if (
      model.url &&
      !/^https:\/\/github\.com\/stevensun1005\/guandanai\/releases\/download\/[^/]+\/[\w.-]+\.onnx$/.test(
        model.url,
      )
    )
      throw Error('Model must use a pinned repository Release asset');
    ids.add(model.id);
    files.add(model.file);
  }
  if (!ids.has(value.defaultId)) throw Error('Missing default model');
  if (value.selection) {
    const champions = value.selection.localChampions;
    if (
      value.selection.mode !== 'champions-v1' ||
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
  return value;
}

validateCatalog(catalog);
export const BOT_MODELS = Object.freeze(catalog.models.map((model) => Object.freeze(model)));
export const DEFAULT_BOT_MODEL = catalog.defaultId;
export const CLINT_RULE_ID = 'clint-rule';
export const botModelId = (value) =>
  value === CLINT_RULE_ID || BOT_MODELS.some((model) => model.id === value)
    ? value
    : DEFAULT_BOT_MODEL;
export const botModel = (value) => {
  if (value === CLINT_RULE_ID) throw Error('Clint rules do not use a neural model');
  return BOT_MODELS.find((model) => model.id === botModelId(value));
};
export const botModelName = (value) => {
  if (value === CLINT_RULE_ID) return 'Clint规则机器人';
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

export function selectableModels(value) {
  const models = value.models;
  if (!value.selection) return models;
  const guanzero = models
    .filter((m) => m.config.history === 'guanzero-v1')
    .slice(-2)
    .reverse();
  const baseline = models.find((m) => m.source?.version === 'P0');
  return [
    { id: CLINT_RULE_ID, kind: 'rule' },
    ...guanzero,
    baseline,
    ...value.selection.localChampions.map((id) => models.find((m) => m.id === id)),
  ].filter(Boolean);
}
export const BOT_CHOICES = Object.freeze(selectableModels(catalog));
export const botChoiceId = (value) =>
  BOT_CHOICES.some((m) => m.id === value) ? value : DEFAULT_BOT_MODEL;
