"""Repeated ready packets cannot overtake queued returns or run their transfer batch twice."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/") + "?test=1"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_function("() => typeof window.hideOverlay === 'function'")
    queued = page.evaluate("""()=>{
 hideOverlay();$('#lobby').hidden=true;resetGame();const d=makeDeck();G.hands=[d.slice(0,28),d.slice(28,54),d.slice(54,82),d.slice(82)];G.phase='prep';G.turn=0;G.leader=0;G.L=2;G.round=2;G.log=[];G.seen=[];G.rest=[];G.fixed=[];G.myOrder=[];G.trib=[];G.gives=[];G.returns=[{from:0,to:1},{from:2,to:3}];G.retPick={0:aiReturnCard(G.hands[0],2).id};G.ready=[1];setHumans([0,1]);render();for(let i=0;i<12;i++)act({k:'ready',p:i%2});return {phase:G.phase,gives:G.gives.length,returns:G.returns.length};
 }""")
    assert queued == {"phase": "tribute", "gives": 2, "returns": 0}, queued
    page.evaluate("Promise.all([runGives(),runGives()])")
    page.wait_for_function("() => (G.phase==='play'&&G.turn===0&&G.clock?.who===0)", timeout=10000)
    counts = page.evaluate("G.hands.map(hand=>hand.length)")
    assert counts == [27] * 4, counts
    assert page.evaluate("new Set(G.hands.flat().map(card=>card.id)).size") == 108
    # An older same-round hold must not reset the lead chosen by a newer transition.
    page.evaluate(
        "G.trib=[{g:2,r:0,tc:G.hands[0][0]}];startPlay(0);setTimeout(()=>startPlay(1),100)"
    )
    page.wait_for_function('() => (G.turn===1&&G.clock?.who===1)', timeout=6000)
    page.wait_for_timeout(500)
    assert page.evaluate("G.turn") == 1
    assert not errors, errors
    report = {
        "duplicateReadyIsIdempotent": True,
        "returnPhaseCommittedBeforeAnimation": True,
        "concurrentTransferRunsOnce": True,
        "eachHand27": True,
        "physicalCards108": True,
        "staleHoldCannotResetLead": True,
        "pageErrors": errors,
    }
    (ROOT / "web/artifacts/validation/ready-transition.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    browser.close()
