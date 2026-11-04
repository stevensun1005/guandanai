/** Artifacts actually shipped with the static application. */
export const MODELS = Object.freeze({
  policy: { file: 'policy.onnx', stateFeatures: 513, actionFeatures: 54 },
  response: { file: 'response.onnx', features: 253, hidden: [64, 32] },
});
