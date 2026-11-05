"""Two independent browser models match native ONNX fixtures and retry safely."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
URL += ("&" if "?" in URL else "?") + "test=1"
fixtures = json.loads((ROOT / "ai/shared/fixtures/response-positions.json").read_text()) + json.loads(
    (ROOT / "ai/shared/fixtures/adaptive-positions.json").read_text()
)
fixtures += json.loads((ROOT / "ai/shared/fixtures/habit-positions.json").read_text(encoding="utf-8"))
WORKER = """state=>new Promise((resolve,reject)=>{
 const w=new Worker(new URL('./assets/ai-worker.mjs',document.baseURI),{type:'module'});
 w.onmessage=({data})=>{w.terminate();data.error?reject(Error(data.error)):resolve(data.result)};
 w.onerror=event=>reject(Error(event.message));w.postMessage({id:1,type:'decide',state});
})"""
RESTORE = """state=>{
 resetGame();hideOverlay();document.querySelector('#lobby').hidden=true;
 const deck=makeDeck(),known=new Set(state.hand.concat(state.log.flatMap(e=>e.cards||[])));
 G.hands=[[],[],[],[]];G.hands[state.p]=state.hand.map(id=>deck[id]);
 const unseen=deck.filter(card=>!known.has(card.id));let offset=0;
 for(let seat=0;seat<4;seat++)if(seat!==state.p){G.hands[seat]=unseen.slice(offset,offset+state.counts[seat]);offset+=state.counts[seat]}
 G.L=state.level;G.levels=[state.selfLevel,state.opponentLevel];if(state.p%2)G.levels.reverse();
 G.log=state.context.log.map(e=>({...e,cards:e.cards?.map(card=>deck[card.id])||null}));
 G.trick=state.context.trick;G.phase='play';G.turn=state.p;G.clock=null;G.round=1;G.myOrder=[];G.fixed=[];G.pw=[];G.seen=[];G.rest=[];
 G.roundHistory=state.roundHistory||[];
 botStyles=Array(4).fill(state.profile);NET.mode='solo';NET.off=0;
}"""
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL, wait_until="networkidle")
    max_error = 0
    changed = 0
    for fixture in fixtures:
        answer = page.evaluate(WORKER, fixture["state"])
        assert answer["index"] == fixture["expectedIndex"], (
            answer["index"],
            fixture["expectedIndex"],
        )
        assert max(abs(a - b) for a, b in zip(answer["values"], fixture["values"])) < 2e-4
        for actual, expected in zip(answer["responseRisks"], fixture["risks"]):
            if expected is None:
                assert actual is None
            else:
                max_error = max(max_error, abs(actual - expected))
                assert abs(actual - expected) < 2e-5
        if fixture["expectedIndex"] != fixture["originalIndex"]:
            changed += 1
        page.evaluate(RESTORE, fixture["state"])
        selected = page.evaluate(
            "async p=>(await TableBot.decide(p))?.cards.map(card=>card.id).sort((a,b)=>a-b)||[]",
            fixture["state"]["p"],
        )
        assert selected == sorted(fixture["state"]["actions"][fixture["expectedIndex"]])
    # A second-model download failure must expose the same retry path, without a policy fallback.
    failed = browser.new_context()
    failed.route("**/models/response.onnx*", lambda route: route.abort())
    fail = failed.new_page()
    fail.on("pageerror", lambda error: errors.append(str(error)))
    fail.goto(URL, wait_until="networkidle")
    fixture = next(item for item in fixtures if item["expectedIndex"] != item["originalIndex"])
    fail.evaluate(RESTORE, fixture["state"])
    before = fail.evaluate("G.log.length")
    fail.evaluate("p=>TableBot.playTurn({who:p})", fixture["state"]["p"])
    fail.locator("#retryTableBtn").wait_for(state="visible", timeout=25000)
    assert fail.evaluate("G.log.length") == before
    failed.unroute("**/models/response.onnx*")
    fail.locator("#retryTableBtn").click()
    fail.wait_for_function("before=>G.log.length>before", arg=before, timeout=60000)
    failed.close()
    assert not errors, errors
    report = {
        "positions": len(fixtures),
        "changedChoices": changed,
        "browserResponseMaxError": max_error,
        "mainPolicyMaxError": "<0.0002",
        "controllerMatchesWorker": True,
        "responseFailureRetry": True,
        "pageErrors": errors,
    }
    (ROOT / "web/artifacts/validation/response-browser.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    browser.close()
