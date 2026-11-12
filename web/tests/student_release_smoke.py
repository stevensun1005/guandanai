"""Candidate shipping worker in actual Chrome WASM; fixed public fixtures, not strength evidence."""
import json
import os
import sys
from playwright.sync_api import sync_playwright

url, reference = sys.argv[1:3]
ref = json.load(open(reference, encoding="utf8"))
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("BROWSER_CHANNEL", "chrome"))
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url, wait_until="networkidle")
    results = page.evaluate("""async ref => {
      const worker = new Worker(new URL('./assets/search-worker.mjs',document.baseURI),{type:'module'});
      let seq=0;const pending=new Map();
      worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p[1](Error(data.error)):p[0](data.result)};
      const call = message => new Promise((ok,fail)=>{const id=++seq;pending.set(id,[ok,fail]);worker.postMessage({id,...message})});
      const budget={solverMs:3000,solverTable:300000,midgameMs:50000,endgameMs:50000};
      try {
        await call({type:'init',bot:ref.bot,budget});const out=[];
        for(const f of ref.fixtures){
          const decision=await call({type:'search',payload:f.payload,remainingMs:50000});
          const coach=await call({type:'coach',payload:f.payload,remainingMs:50000});out.push({decision,coach});
        }return out;
      } finally {worker.terminate()}
    }""", ref)
    maximum = 0
    for f, r in zip(ref["fixtures"], results):
        d, c = r["decision"], r["coach"]
        assert d["ok"] and d["index"] == f["index"] and d["ids"] == f["ids"], (f, d)
        assert d["kind"] == f["kind"] and d["worldsUsed"] == 0
        if f["kind"] == "endgame-student":
            assert c["ok"] and c["kind"] == "endgame-student"
            assert len(c["values"]) == len(f["values"])
            maximum = max(maximum, max(abs(a-b) for a,b in zip(c["values"], f["values"])))
    assert maximum < 2e-4, maximum
    assert not errors, errors
    print(json.dumps({"fixturePositions":len(results),"argmaxAllEqual":True,"maxAbsValueDifference":maximum,
                      "studentSHA256":ref["studentSHA256"],"pageErrors":errors,"scope":"compatibility-not-strength"}))
    browser.close()
