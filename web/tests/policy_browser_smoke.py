"""Check a candidate policy in isolated Chrome WASM, without rebuilding the game."""

import argparse
from datetime import datetime, timezone
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

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/danMCai/training"))
from policy_features import encode_policy_extras_batch  # noqa: E402
from policy_learning import RolloutEngine  # noqa: E402

FIXTURES = r"""
import { createRound, advanceRound } from './ai/shared/simulation/simulation.mjs';
import { candidates } from './web/src/ai/candidates.js';
import { policyState, decisionContext } from './web/src/ai/observation.js';
import { createPolicyInference } from './ai/shared/simulation/policy-inference.mjs';
import { existsSync } from 'node:fs';
const engine=createPolicyInference({python:PYTHON,env:{GUANDAN_POLICY_MODEL:FIXTURE_POLICY}}), samples=[];
const fixtureSeeds=FIXTURE_SEEDS;
const stopped=()=> (STOP_FILE && existsSync(STOP_FILE)) || (DEADLINE_MS && Date.now()>=DEADLINE_MS);
const needed={afterFirstOut:8,alias:8,afterPass:8,wide:8,lead:8,follow:8};
try {
  for(let round=0;round<fixtureSeeds.length&&samples.length<48;round++) {
    const seed=fixtureSeeds[round], game=createRound(seed);
    for(let turn=0;turn<1000;turn++) {
      if(stopped())throw Error('Browser fixture deadline or STOP');
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
      let selected=RAW_FIXTURES ? -1 : plays.findIndex(play=>play&&play.cards.length===game.hands[game.turn].length);
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
    parser.add_argument("--complete-match", action="store_true")
    parser.add_argument("--fixture-policy")
    parser.add_argument("--fixture-seeds")
    parser.add_argument("--raw-fixtures", action="store_true")
    parser.add_argument("--strict-argmax", action="store_true")
    parser.add_argument("--stop-file")
    parser.add_argument("--deadline")
    parser.add_argument("--output", default="web/artifacts/validation/candidate-browser")
    args = parser.parse_args()
    model = Path(args.model).resolve()
    output = Path(args.output).resolve()
    # Artifacts belong to this test; the production dist directory is never served or changed.
    harness = output / "harness"
    vendor = harness / "vendor"
    vendor.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    deadline=datetime.fromisoformat(args.deadline.replace('Z','+00:00')) if args.deadline else None
    def check_live():
        if (args.stop_file and Path(args.stop_file).exists()) or (deadline and datetime.now(timezone.utc)>=deadline):
            raise InterruptedError('Browser validation deadline or STOP')
    check_live()
    fixture_policy=Path(args.fixture_policy).resolve() if args.fixture_policy else ROOT/'ai/danMCai/models/baseline/policy.onnx'
    fixture_seeds=json.loads(Path(args.fixture_seeds).read_text()) if args.fixture_seeds else list(range(21890104,21890168))
    if isinstance(fixture_seeds,dict): fixture_seeds=fixture_seeds['browserSeeds']
    if not fixture_seeds or len(set(fixture_seeds))!=len(fixture_seeds):
        raise ValueError('Invalid fixture seeds')
    fixture_code=(FIXTURES.replace('PYTHON',json.dumps(sys.executable))
                  .replace('FIXTURE_POLICY',json.dumps(str(fixture_policy)))
                  .replace('FIXTURE_SEEDS',json.dumps(fixture_seeds))
                  .replace('RAW_FIXTURES','true' if args.raw_fixtures else 'false')
                  .replace('STOP_FILE',json.dumps(args.stop_file))
                  .replace('DEADLINE_MS',str(int(deadline.timestamp()*1000)) if deadline else 'null'))
    generated = subprocess.run(
        ["node", "--input-type=module", "-e", fixture_code],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=max(.1,(deadline-datetime.now(timezone.utc)).total_seconds()) if deadline else None,
    )
    fixtures = json.loads(generated.stdout)
    if args.complete_match:
        for fixture in fixtures:
            state = fixture["state"]
            level = state["level"]
            state["match"] = {
                "levels": [level, level],
                "lvlTeam": 0,
                "aFails": [0, 0],
                "round": 2 * (level - 2) + 1,
                "previousOrder": [0, 2, 1, 3] if level > 2 else None,
            }

    fixtures_path = output / "positions.json"
    fixtures_path.write_text(json.dumps(fixtures), encoding="utf-8")
    shutil.copy2(model, harness / "policy.onnx")
    for name in ("ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"):
        shutil.copy2(ROOT / "node_modules/onnxruntime-web/dist" / name, vendor / name)
    if args.complete_match:
        from full_learning import FullEngine

        native = FullEngine(model)
        runtime_config = {"extraFeatures": 61}
    else:
        native = RolloutEngine(model)
        runtime_config = {"extraFeatures": 53} if native.has_extras else {}

    entry = (
        WORKER.replace(
            "__POLICY_MODULE__", json.dumps((ROOT / "web/src/ai/policy-inference.mjs").as_posix())
        )
        .replace("EXTRAS", json.dumps((ROOT / "web/src/ai/policy-features.mjs").as_posix()))
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
                page.wait_for_function("() => (typeof window.evaluatePolicy==='function')")
                for index, fixture in enumerate(fixtures):
                    check_live()
                    state = fixture["state"]
                    expected = native.score(state)[0]
                    extra = encode_policy_extras_batch(state)
                    timeout_ms=max(1,min(60000,int((deadline-datetime.now(timezone.utc)).total_seconds()*1000))) if deadline else 60000
                    actual = page.evaluate("([state,ms])=>Promise.race([window.evaluatePolicy(state),new Promise((_,reject)=>setTimeout(()=>reject(Error('Fixed validation deadline')),ms))])", [state,timeout_ms])
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
                        and float(expected[best] - expected[chosen]) > (0 if args.strict_argmax else 2 * error + 1e-6)
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
        "fixturePolicySHA256": sha(fixture_policy),
        "fixtureSeeds":fixture_seeds,
        "rawFixtures":args.raw_fixtures,
        "strictNonTieArgmax":args.strict_argmax,
        "productionRuntimeSHA256": sha(ROOT / "web/src/ai/policy-inference.mjs"),
        "runtimeConfig": runtime_config,
        "featureSHA256": sha(ROOT / "web/src/ai/policy-features.mjs"),
        "nativeFeatureSHA256": sha(ROOT / "ai/danMCai/training/policy_features.py"),
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
