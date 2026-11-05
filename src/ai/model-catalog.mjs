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
  return value;
}

validateCatalog(catalog);
export const BOT_MODELS = Object.freeze(catalog.models.map((model) => Object.freeze(model)));
export const DEFAULT_BOT_MODEL = catalog.defaultId;
export const botModelId = (value) =>
  BOT_MODELS.some((model) => model.id === value) ? value : DEFAULT_BOT_MODEL;
export const botModel = (value) => BOT_MODELS.find((model) => model.id === botModelId(value));
export const botModelName = (value) => {
  const model = botModel(value);
  if (model.config.history === 'guanzero-v1' && model.source?.run) {
    const checkpoint = Number.isSafeInteger(model.source.step)
      ? `${model.source.step}步`
      : model.source.version;
    return checkpoint ? `${model.source.run} · ${checkpoint}` : model.source.run;
  }
  return model.source?.version === 'P0' ? 'v000000000' : model.source?.version || model.id;
};
