"""Check a candidate policy in isolated Chrome WASM, without rebuilding the game."""

import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

import numpy as np
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from policy_features import encode_policy_extras_batch  # noqa: E402
from policy_learning import RolloutEngine  # noqa: E402

FIXTURES = r"""
import { createRound, advanceRound } from './scripts/lib/simulation.mjs';
import { candidates } from './src/ai/candidates.js';
import { policyState, decisionContext } from './src/ai/observation.js';
import { createPolicyInference } from './scripts/lib/policy-inference.mjs';
const engine=createPolicyInference(), samples=[];
const needed={afterFirstOut:8,alias:8,afterPass:8,wide:8,lead:8,follow:8};
try {
  for(let round=0;round<64&&samples.length<48;round++) {
    const seed=21890104+round, game=createRound(seed);
    for(let turn=0;turn<1000;turn++) {
      const plays=candidates(game.hands[game.turn],game.L,game.trick?.play);
      const state=policyState(game,game.turn,0,plays);
      state.trick=decisionContext(game,game.turn).trick;
      state.actionShapes=plays.map(play=>play&&({type:play.type,value:play.value,n:play.n}));
      const keys=new Set();let alias=false;
      for(const play of plays) {
        if(!play)continue;
        const key=play.cards.map(card=>card.id%54).sort((a,b)=>a-b).join(',');
        if(keys.has(key)){alias=true;break}keys.add(key);
      }
      const flags={afterFirstOut:game.out.length>0,alias,
        afterPass:!!game.trick&&!!game.log.length&&!game.log.at(-1).cards,
        wide:plays.length>128,lead:!game.trick,follow:!!game.trick};
      const category=Object.keys(needed).find(key=>needed[key]>0&&flags[key]);
      if(category&&plays.length>1) {
        samples.push({seed,turn,category,flags,state});needed[category]--;
      }
      let selected=plays.findIndex(play=>play&&play.cards.length===game.hands[game.turn].length);
      if(selected<0&&plays.length===1)selected=0;
      if(selected<0) {
        const values=await engine.infer(state);
        selected=values.reduce((best,value,index)=>value>values[best]?index:best,0);
      }
      if(advanceRound(game,plays[selected]))break;
    }
  }
  if(samples.length!==48||Object.values(needed).some(Boolean))throw Error('Missing coverage: '+JSON.stringify(needed));
  console.log(JSON.stringify(samples));
} finally { engine.close(); }
"""

WORKER = r"""
import * as ort from './vendor/ort.wasm.min.mjs';
import { inferPolicy } from __POLICY_MODULE__;
import { encodePolicyExtrasBatch, POLICY_EXTRA_FEATURES } from EXTRAS;
ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
let model;
self.onmessage=async ({data:state})=>{
  try {
    model ||= await ort.InferenceSession.create(new URL('./policy.onnx',import.meta.url).href,
      {executionProviders:['wasm'],graphOptimizationLevel:'all'});
    const result=await inferPolicy(ort,model,state,CONFIG);
    const extras=encodePolicyExtrasBatch(state);
    const indices=[...new Set([0,Math.floor(state.actions.length/2),state.actions.length-1])];
    self.postMessage({...result,
      extraRows:indices.map(index=>({index,values:Array.from(extras.slice(index*POLICY_EXTRA_FEATURES,(index+1)*POLICY_EXTRA_FEATURES))}))});
  } catch(error) { self.postMessage({error:String(error.stack||error)}); }
};
"""

PAGE = """<!doctype html><meta charset="utf-8"><title>Candidate policy validation</title>
<p>Local candidate numerical validation.</p><script type="module">
const worker=new Worker('./worker.mjs',{type:'module'});
window.evaluatePolicy=state=>new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Candidate inference timed out')),60000);
  worker.onmessage=({data})=>{clearTimeout(timeout);data.error?reject(Error(data.error)):resolve(data)};
  worker.onerror=event=>{clearTimeout(timeout);reject(Error(event.message))};worker.postMessage(state);
});
window.closePolicy=()=>worker.terminate();
</script>"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", default="work/validation/candidate-browser")
    args = parser.parse_args()
    model = Path(args.model).resolve()
    output = Path(args.output).resolve()
    # Artifacts belong to this test; the production dist directory is never served or changed.
    harness = output / "harness"
    vendor = harness / "vendor"
    vendor.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    generated = subprocess.run(
        ["node", "--input-type=module", "-e", FIXTURES],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    fixtures = json.loads(generated.stdout)
    fixtures_path = output / "positions.json"
    fixtures_path.write_text(json.dumps(fixtures), encoding="utf-8")
    shutil.copy2(model, harness / "policy.onnx")
    for name in ("ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"):
        shutil.copy2(ROOT / "node_modules/onnxruntime-web/dist" / name, vendor / name)
    native = RolloutEngine(model)
    runtime_config = {"extraFeatures": 53} if native.has_extras else {}
    entry = (
        WORKER.replace(
            "__POLICY_MODULE__", json.dumps((ROOT / "src/ai/policy-inference.mjs").as_posix())
        )
        .replace("EXTRAS", json.dumps((ROOT / "src/ai/policy-features.mjs").as_posix()))
        .replace("CONFIG", json.dumps(runtime_config))
    )
    (harness / "entry.mjs").write_text(entry, encoding="utf-8")
    config = {
        "entryPoints": [str(harness / "entry.mjs")],
        "outfile": str(harness / "worker.mjs"),
        "bundle": True,
        "format": "esm",
        "target": "es2022",
        "external": ["./vendor/*"],
    }
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import {build} from 'esbuild';await build(JSON.parse(process.argv[1]));",
            json.dumps(config),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    (harness / "index.html").write_text(PAGE, encoding="utf-8")
    errors, checks = [], []
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(harness)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    max_error = 0.0
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, channel="chrome")
            try:
                context = browser.new_context()
                # Any accidental remote dependency is an error, rather than a hidden online fallback.
                context.route(
                    "**/*",
                    lambda route: route.continue_()
                    if route.request.url.startswith(f"http://127.0.0.1:{server.server_port}/")
                    else route.abort(),
                )
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:{server.server_port}/", wait_until="networkidle")
                page.wait_for_function("typeof window.evaluatePolicy==='function'")
                for index, fixture in enumerate(fixtures):
                    state = fixture["state"]
                    expected, _, _ = native.score(state)
                    extra = encode_policy_extras_batch(state)
                    actual = page.evaluate("state=>window.evaluatePolicy(state)", state)
                    values = np.array(actual["values"], dtype=np.float32)
                    if (
                        values.shape != expected.shape
                        or not np.isfinite(values).all()
                        or not np.isfinite(expected).all()
                    ):
                        raise AssertionError(f"Position {index}: invalid model output")
                    error = float(np.max(np.abs(values - expected)))
                    max_error = max(max_error, error)
                    if error >= 2e-4:
                        raise AssertionError(f"Position {index}: maximum value error {error}")
                    for row in actual["extraRows"]:
                        np.testing.assert_array_equal(
                            np.asarray(row["values"], dtype=np.float32), extra[row["index"]]
                        )
                    best = int(expected.argmax())
                    chosen = actual["index"]
                    if (
                        best != chosen
                        and float(expected[best] - expected[chosen]) > 2 * error + 1e-6
                    ):
                        raise AssertionError(
                            f"Position {index}: non-tied argmax mismatch {best}/{chosen}"
                        )
                    checks.append(
                        {
                            "position": index,
                            "category": fixture["category"],
                            "actions": len(expected),
                            "maxError": error,
                            "nativeIndex": best,
                            "browserIndex": chosen,
                            "exactArgmax": best == chosen,
                            "nativeValueGap": float(expected[best] - expected[chosen]),
                        }
                    )
                page.evaluate("window.closePolicy()")
                browser_version = browser.version
                context.close()
            finally:
                browser.close()
        if errors:
            raise AssertionError(errors)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    report = {
        "model": str(model),
        "modelSHA256": sha(model),
        "fixturesSHA256": sha(fixtures_path),
        "fixturePolicySHA256": sha(ROOT / "ai/policy.onnx"),
        "productionRuntimeSHA256": sha(ROOT / "src/ai/policy-inference.mjs"),
        "runtimeConfig": runtime_config,
        "featureSHA256": sha(ROOT / "src/ai/policy-features.mjs"),
        "nativeFeatureSHA256": sha(ROOT / "scripts/policy_features.py"),
        "wasmSHA256": sha(vendor / "ort-wasm-simd-threaded.wasm"),
        "testSHA256": sha(Path(__file__)),
        "browser": browser_version,
        "backend": "Chrome dedicated Worker, ONNX Runtime Web WASM, one thread",
        "positions": len(checks),
        "actions": sum(row["actions"] for row in checks),
        "maxError": max_error,
        "exactArgmax": sum(row["exactArgmax"] for row in checks),
        "tieOnlyMismatches": sum(not row["exactArgmax"] for row in checks),
        "featureRowsExact": True,
        "pageErrors": errors,
        "productionBuildTouched": False,
        "serverClosed": not thread.is_alive(),
        "elapsedSeconds": time.monotonic() - started,
        "checks": checks,
    }
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "checks"}))


if __name__ == "__main__":
    main()
