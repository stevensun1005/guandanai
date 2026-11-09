/* The browser search worker reuses research modules (ai/danMCai/belief/sampler.mjs) whose only
   Node imports serve local file loading the web never calls; map them to a stub that throws. */
export const nodeStub = {
  name: 'node-stub',
  setup(builder) {
    builder.onResolve({ filter: /^node:(fs|path)$/ }, (args) => ({
      path: args.path,
      namespace: 'node-stub',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      contents:
        "const unavailable = () => { throw Error('Node file APIs are unavailable in the browser'); };" +
        'export const existsSync = unavailable, readFileSync = unavailable, dirname = unavailable, join = unavailable;',
      loader: 'js',
    }));
  },
};
