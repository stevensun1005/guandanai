"""Validate PPO export and stable global top-K in an isolated Chrome WASM worker."""

import argparse
import copy
from functools import partial
from http.server import ThreadingHTTPServer
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
sys.path.insert(0, str(ROOT / "ai/local/training"))
from export_ppo import export_ppo  # noqa: E402
from ppo_learning import PPOEngine  # noqa: E402
from ppo_onnx_inference import PPOOnnxEngine  # noqa: E402
from policy_browser_smoke import FIXTURES, PAGE, QuietHandler, sha  # noqa: E402

WORKER = r"""
import * as ort from './vendor/ort.wasm.min.mjs';
import { encode, cardsArray } from ENCODING;
import { inferPolicy } from POLICY;
import { encodePolicyExtrasBatch } from EXTRAS;
const contract=CONTRACT;
ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
let model;
self.onmessage=async ({data:state})=>{
  try {
    model ||= await ort.InferenceSession.create(new URL('./policy.onnx',import.meta.url).href,
      {executionProviders:['wasm'],graphOptimizationLevel:'all'});
    const features=encode(state),extras=encodePolicyExtrasBatch(state),proposals=[],logits=[];
    const stateTensor=new ort.Tensor('float32',features,[1,513]);
    try {
      for(let first=0;first<state.actions.length;first+=128){
        const chunk=state.actions.slice(first,first+128),batch=new Float32Array(chunk.length*54);
        chunk.forEach((cards,index)=>batch.set(cardsArray(cards),index*54));
        const actionTensor=new ort.Tensor('float32',batch,[chunk.length,54]);
        const extraTensor=new ort.Tensor('float32',extras.slice(first*53,(first+chunk.length)*53),[chunk.length,53]);
        let result;
        try {
          result=await model.run({state:stateTensor,actions:actionTensor,extras:extraTensor});
          proposals.push(...result.values.data);logits.push(...result.policy_logits.data);
        } finally {
          actionTensor.dispose();extraTensor.dispose();
          if(result)Object.values(result).forEach(tensor=>tensor.dispose());
        }
      }
    } finally { stateTensor.dispose(); }
    if(!proposals.every(Number.isFinite)||!logits.every(Number.isFinite))throw Error('Nonfinite output');
    const result=await inferPolicy(ort,model,state,{extraFeatures:53,rerankCandidates:contract.k,temperature:contract.temperature});
    const selected=state.counts.every(count=>count>0)
      ? proposals.map((_,index)=>index).filter(index=>result.values[index]>-1e8).sort((a,b)=>proposals[b]-proposals[a]||a-b)
      : [];
    self.postMessage({...result,proposals,logits,selected});
  } catch(error){self.postMessage({error:String(error.stack||error)})}
};
"""


def edge_cases(fixtures, reference):
    wide = next(
        item
        for item in fixtures
        if len(item["state"]["actions"]) > 256 and min(item["state"]["counts"]) > 0
    )
    repeated = copy.deepcopy(wide)
    repeated["category"] = "repeated-legal-action-stable-tie"
    state = repeated["state"]
    state["actions"] = [state["actions"][0]] * 131
    state["actionShapes"] = [state["actionShapes"][0]] * 131
    one = copy.deepcopy(repeated)
    one["category"] = "single-legal-candidate"
    one["state"]["actions"] = one["state"]["actions"][:1]
    one["state"]["actionShapes"] = one["state"]["actionShapes"][:1]
    reordered = copy.deepcopy(wide)
    reordered["category"] = "global-top-k-across-batch-boundaries"
    state = reordered["state"]
    proposals, _, _ = reference.proposal.score(state)
    preferred = np.argsort(-proposals, kind="stable")[: reference.config["k"]].tolist()
    locations = [0, 127, 128, len(proposals) - 1][: len(preferred)]
    fixed = dict(zip(locations, preferred))
    rest = iter(index for index in range(len(proposals)) if index not in preferred)
    order = [fixed[index] if index in fixed else next(rest) for index in range(len(proposals))]
    state["actions"] = [state["actions"][index] for index in order]
    state["actionShapes"] = [state["actionShapes"][index] for index in order]
    return [repeated, one, reordered]


def compare_scores(actual, expected, label):
    actual = np.asarray(actual, np.float32)
    if (
        actual.shape != expected.shape
        or not np.isfinite(actual).all()
        or not np.isfinite(expected).all()
    ):
        raise AssertionError(f"Invalid {label} outputs")
    error = float(np.max(np.abs(actual - expected)))
    if error >= 2e-4:
        raise AssertionError(f"{label}: maximum error {error}")
    if int(actual.argmax()) != int(expected.argmax()):
        raise AssertionError(f"{label}: argmax differs {actual.argmax()}/{expected.argmax()}")
    return error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--model")
    parser.add_argument("--output", default="web/artifacts/validation/ppo-browser")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    harness = output / "harness"
    vendor = harness / "vendor"
    vendor.mkdir(parents=True, exist_ok=True)
    checkpoint = Path(args.checkpoint).resolve()
    model = Path(args.model).resolve() if args.model else output / "policy.onnx"
    if not args.model:
        export_ppo(checkpoint, model)
    started = time.monotonic()
    reference = PPOEngine(checkpoint)
    native = PPOOnnxEngine(model)
    if (
        native.config["actorSHA256"] != sha(checkpoint)
        or native.config["policySHA256"] != reference.policy_hash
    ):
        raise ValueError("ONNX and checkpoint do not identify the same learned actor")
    generated = subprocess.run(
        ["node", "--input-type=module", "-e", FIXTURES],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    fixtures = json.loads(generated.stdout)
    fixtures.extend(edge_cases(fixtures, reference))
    fixture_path = output / "positions.json"
    fixture_path.write_text(json.dumps(fixtures), encoding="utf-8")
    shutil.copy2(model, harness / "policy.onnx")
    for name in ("ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"):
        shutil.copy2(ROOT / "node_modules/onnxruntime-web/dist" / name, vendor / name)
    entry = (
        WORKER.replace("ENCODING", json.dumps((ROOT / "web/src/ai/encoding.mjs").as_posix()))
        .replace("EXTRAS", json.dumps((ROOT / "web/src/ai/policy-features.mjs").as_posix()))
        .replace("CONTRACT", json.dumps(native.config))
        .replace("POLICY", json.dumps((ROOT / "web/src/ai/policy-inference.mjs").as_posix()))
    )
    (harness / "entry.mjs").write_text(entry, encoding="utf-8")
    build = {
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
            json.dumps(build),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    (harness / "index.html").write_text(PAGE, encoding="utf-8")
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(harness)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors, checks = [], []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, channel="chrome")
            try:
                context = browser.new_context()
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
                    state = fixture["state"]
                    expected = reference.score(state)
                    proposals, logits = native.raw(state)
                    exported = native.score(state)
                    native_error = compare_scores(exported, expected, f"Native position {index}")
                    actual = page.evaluate("state=>window.evaluatePolicy(state)", state)
                    browser_expected = expected.copy()
                    if min(state["counts"]) > 0:
                        selected = browser_expected > -1e8
                        browser_expected[selected] *= native.config["temperature"]
                    browser_error = compare_scores(
                        actual["values"], browser_expected, f"Browser position {index}"
                    )
                    proposal_error = float(
                        np.max(np.abs(np.asarray(actual["proposals"], np.float32) - proposals))
                    )
                    logit_error = float(
                        np.max(np.abs(np.asarray(actual["logits"], np.float32) - logits))
                    )
                    if proposal_error >= 2e-4 or logit_error >= 2e-4:
                        raise AssertionError(
                            f"Raw PPO output mismatch: {proposal_error}, {logit_error}"
                        )
                    if min(state["counts"]) == 0:
                        np.testing.assert_array_equal(exported, proposals)
                        np.testing.assert_array_equal(actual["values"], actual["proposals"])
                    else:
                        expected_top = np.argsort(-proposals, kind="stable")[
                            : native.config["k"]
                        ].tolist()
                        if actual["selected"] != expected_top:
                            raise AssertionError(
                                f"Global top-K mismatch: {actual['selected']}/{expected_top}"
                            )
                    checks.append(
                        {
                            "position": index,
                            "category": fixture["category"],
                            "actions": len(expected),
                            "nativeError": native_error,
                            "browserError": browser_error,
                            "proposalError": proposal_error,
                            "logitError": logit_error,
                            "index": actual["index"],
                            "globalTopK": actual["selected"],
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
        "actorSHA256": sha(checkpoint),
        "contract": native.config,
        "fixturesSHA256": sha(fixture_path),
        "testSHA256": sha(Path(__file__)),
        "productionRuntimeSHA256": sha(ROOT / "web/src/ai/policy-inference.mjs"),
        "runtimeConfig": {
            "extraFeatures": 53,
            "rerankCandidates": native.config["k"],
            "temperature": native.config["temperature"],
        },
        "browserScoreScale": "Selected PPO log probabilities multiplied by temperature; after first finish unchanged proposal scores.",
        "browser": browser_version,
        "backend": "Chrome dedicated Worker, ONNX Runtime Web WASM, one thread",
        "realPositions": 48,
        "edgeCases": 3,
        "positions": len(checks),
        "actions": sum(item["actions"] for item in checks),
        "nativeMaxError": max(item["nativeError"] for item in checks),
        "browserMaxError": max(item["browserError"] for item in checks),
        "rawLogitMaxError": max(item["logitError"] for item in checks),
        "exactArgmax": len(checks),
        "globalTopKMatches": True,
        "afterFirstFinishUnchanged": True,
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
