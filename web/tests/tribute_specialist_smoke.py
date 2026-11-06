"""Real Chrome WASM, private-input boundary and async tribute/early-return conservation."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
from pathlib import Path
import threading
import subprocess
import sys
import numpy as np
import onnxruntime as ort
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())


def main(run):
    run = Path(run)
    fixtures = json.loads((run / "browser-fixtures.json").read_text())
    best = json.loads((run / "learner/best.json").read_text())
    manifest = json.loads((ROOT / "web/src/ai/tribute-model.json").read_text())
    if not manifest["enabled"] or manifest["sha256"] != best["sha256"]:
        raise ValueError("Validation requires this candidate enabled in isolated build")
    model = run / "learner/best.onnx"
    if hashlib.sha256(model.read_bytes()).hexdigest() != best["sha256"]:
        raise ValueError("Candidate checksum mismatch")
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT / "web/dist"))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"
    errors, maximum, decisions = [], 0.0, 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel="chrome")
            page = browser.new_page(viewport={"width": 1280, "height": 850})
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.add_init_script(
                """window.phaseRequests=[];const Base=Worker;window.Worker=class extends Base{postMessage(data,...rest){if(data.state?.stage)window.phaseRequests.push(data);return super.postMessage(data,...rest)}}"""
            )
            page.goto(url + "?test=1", wait_until="networkidle")
            page.wait_for_function("() => typeof window.hideOverlay === 'function'")
            page.evaluate(
                """async file=>{
              const ort=await import('./assets/vendor/ort.wasm.min.mjs');ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=new URL('./assets/vendor/',location.href).href;
              window.specOrt=ort;window.specEngine=await ort.InferenceSession.create('./models/'+file,{executionProviders:['wasm']});
              window.specWorker=new Worker('./assets/tribute-worker.mjs',{type:'module'});
            }""",
                manifest["file"],
            )
            for item in fixtures["states"]:
                n = len(item["actions"])
                cpu = session.run(
                    ["values"],
                    {"features": np.asarray(item["rows"], dtype=np.float32).reshape(n, 389)},
                )[0]
                wasm = page.evaluate(
                    """async x=>{const input=new specOrt.Tensor('float32',new Float32Array(x.rows),[x.actions.length,389]);let out;try{out=await specEngine.run({features:input});return Array.from(out.values.data)}finally{input.dispose();if(out)Object.values(out).forEach(t=>t.dispose())}}""",
                    item,
                )
                maximum = max(maximum, float(np.max(np.abs(cpu.ravel() - wasm))))
                np.testing.assert_allclose(cpu.ravel(), wasm, atol=2e-5, rtol=2e-5)
                for head in (0, 1):
                    values = cpu[:, head]
                    chosen = next(
                        i for i, a in enumerate(item["actions"]) if a % 54 == item["baseline"] % 54
                    )
                    for i, v in enumerate(values):
                        if v > values[chosen] + 1e-6:
                            chosen = i
                    actual = page.evaluate(
                        """x=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker timeout')),15000);specWorker.onmessage=e=>{clearTimeout(timer);e.data.error?reject(Error(e.data.error)):resolve(e.data.result)};specWorker.postMessage({id:1,state:x.state,head:x.head,baseline:x.baseline})})""",
                        {**item, "head": head},
                    )
                    assert actual == item["actions"][chosen], (actual, item["actions"][chosen])
                    decisions += 1
            page.evaluate(
                """x=>{hideOverlay();$('#lobby').hidden=true;resetGame();const deck=makeDeck();G.hands=x.hands.map(h=>h.map(id=>deck[id]));G.L=x.L;G.levels=x.levels;G.prevOut=x.order;G.round=2;G.log=[];G.seen=[];G.rest=[];G.pw=[];G.myOrder=[];G.fixed=[];G.fresh=[];G.gives=[];G.trib=[];G.returns=[];setHumans([0]);botModels=['012','012','012','012'];doTribute()}""",
                fixtures["table"],
            )
            page.wait_for_function("() => G.phase==='prep'", timeout=25000)
            page.wait_for_function("() => G.returns.length===0", timeout=25000)
            assert page.evaluate("G.hands.map(h=>h.length)") == [27] * 4
            assert page.evaluate("new Set(G.hands.flat().map(c=>c.id)).size") == 108
            payloads = page.evaluate("phaseRequests")
            assert payloads
            for item in payloads:
                state = item["state"]
                assert "hands" not in state and "secretOpponentCards" not in state
                if state["stage"] == "tribute":
                    assert state["publicOffers"] == []
            # Clint still goes through the synchronous original tribute path.
            before = len(payloads)
            page.evaluate(
                """x=>{resetGame();const deck=makeDeck();G.hands=x.hands.map(h=>h.map(id=>deck[id]));G.L=x.L;G.levels=x.levels;G.prevOut=x.order;G.round=2;G.log=[];G.seen=[];G.rest=[];G.pw=[];G.myOrder=[];G.fixed=[];G.fresh=[];G.gives=[];G.trib=[];G.returns=[];setHumans([0]);botModels=['clint-rule','clint-rule','clint-rule','clint-rule'];doTribute()}""",
                fixtures["table"],
            )
            page.wait_for_function("() => G.phase==='prep'", timeout=25000)
            page.wait_for_function("() => G.returns.length===0", timeout=25000)
            assert len(page.evaluate("phaseRequests")) == before
            assert page.evaluate("G.hands.map(h=>h.length)") == [27] * 4
            assert not errors, errors
            browser.close()
        (ROOT / "web/artifacts/validation").mkdir(parents=True, exist_ok=True)
        regressions = {}
        for script in ["tribute_smoke.py", "ready_transition_smoke.py", "rejoin_smoke.py"]:
            completed = subprocess.run(
                [sys.executable, "-X", "utf8", str(ROOT / "web/tests" / script), url],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf8",
                timeout=180,
            )
            if completed.returncode:
                raise RuntimeError(
                    script + " failed: " + completed.stdout[-2000:] + completed.stderr[-3000:]
                )
            regressions[script] = completed.stdout.strip()
        result = {
            "kind": "browser-compatibility-not-strength",
            "candidateSHA256": best["sha256"],
            "states": len(fixtures["states"]),
            "headDecisions": decisions,
            "maxAbsoluteError": maximum,
            "asyncTributeAndEarlyReturn": True,
            "clintUnchanged": True,
            "privateHandsNotSent": True,
            "cards108": True,
            "pageErrors": errors,
            "regressions": regressions,
        }
        (run / "browser-validation.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    main(parser.parse_args().run)
