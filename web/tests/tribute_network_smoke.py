"""Independent double tribute, return and rotated guest recovery with real PeerJS."""

import json
import sys
from playwright.sync_api import expect, sync_playwright

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/").rstrip("/") + "/?test=1"
SETUP = """()=>{
  resetGame();
  const deck=makeDeck();
  const a=deck.filter(c=>c.r===2&&c.s!=='H'&&c.id<54).slice(0,2);
  const b=deck.filter(c=>c.r===2&&c.s!=='H'&&c.id>=54).slice(0,2);
  if(a.length!==2||b.length!==2)throw Error('Expected distinct highest suits');
  const remaining=deck.filter(c=>c.r<=14&&c.r!==2);
  const east=[...a,...remaining.slice(0,25)], west=[...b,...remaining.slice(25,50)];
  const taken=new Set([...east,...west].map(c=>c.id));
  const rest=deck.filter(c=>!taken.has(c.id));
  const abs=[rest.slice(0,27),east,rest.slice(27),west];
  const hands=Array.from({length:4},(_,i)=>abs[toAbs(i)]);
  Object.assign(G,{hands,L:2,round:2,prevOut:[0,2,1,3].map(toLocal),log:[],seen:[],
    rest:[],pw:[],gives:[],trib:[],returns:[]});
  botModels=['clint-rule','clint-rule','clint-rule','clint-rule'];
  doTribute();
}"""
SNAP = """()=>Array.from({length:4},(_,p)=>G.hands[toLocal(p)].map(c=>c.id).sort((a,b)=>a-b))"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    viewports = [(1440, 1000), (844, 390), (390, 844)]
    pages, errors, blocked = [], [], []
    for width, height in viewports:
        ctx = browser.new_context(viewport={"width": width, "height": height})
        ctx.route(
            "https://guandan-human-games-collector.couple-ledger-service.workers.dev/**",
            lambda route: (blocked.append(True), route.abort()),
        )
        page = ctx.new_page()
        page.on("pageerror", lambda err: errors.append(err.stack or str(err)))
        page.goto(URL, wait_until="networkidle")
        pages.append(page)
    host, east, west = pages
    host.locator("#nick").fill("测试桌")
    host.locator('[data-mode="host"]').click()
    host.wait_for_function("()=>NET.peerOpen")
    code = host.evaluate("NET.code")
    host.locator('[data-seat="S"]').click()
    for seat, page in [("E", east), ("W", west)]:
        page.locator("#nick").fill("测试" + seat)
        page.locator('[data-mode="join"]').click()
        page.locator("#roomCode").fill(code)
        page.locator("#joinPad [data-k=go]").click()
        page.wait_for_function("()=>NET.hostConn?.open")
        page.locator(f'[data-seat="{seat}"]').click()
    host.wait_for_function("()=>NET.lobby.E && NET.lobby.W")
    host.locator("#sitBtn").click()
    for page in pages:
        page.wait_for_function("()=>G?.phase==='shuffle'||G?.phase==='cut'||G?.phase==='deal'")
        page.evaluate(SETUP)

    east.evaluate("sel=new Set([tribOptions(0)[0].id]);renderHand()")
    east.locator("#returnBtn").click()
    east.locator("#cfmGo").click()
    host.wait_for_function("()=>G.trib.length===1 && owesReturn(0)")
    assert host.evaluate("G.phase==='tribPick' && G.tribPick[3]==null && G.clock.who==='tribute'")
    assert host.evaluate("G.trib[0].g===1 && G.trib[0].r===0 && G.leader===1")
    expect(west.locator("#tribBox")).to_be_visible()
    host.evaluate("sel=new Set([aiReturnCard(G.hands[0],G.L).id]);renderHand()")
    host.locator("#returnBtn").click()
    expect(host.locator("#cfmGo")).to_have_text("确认还贡")
    expect(host.locator("#tribBox")).to_be_hidden()
    expect(west.locator("#tribBox")).to_be_visible()
    host.locator("#cfmGo").click()
    for page in pages:
        page.wait_for_function("()=>G.trib[0]?.rc && G.phase==='tribPick'")
    assert host.evaluate(SNAP) == east.evaluate(SNAP) == west.evaluate(SNAP)
    east.reload(wait_until="networkidle")
    east.wait_for_function("()=>NET.mode==='guest' && G.phase==='tribPick' && G.tribPick[0]!=null")
    assert east.evaluate(SNAP) == host.evaluate(SNAP)
    assert east.evaluate("G.tributeRoutes.some(x=>x.from===0&&toAbs(x.to)===0)")
    assert west.evaluate("owesTribute(0)")
    west.evaluate("sel=new Set([tribOptions(0)[0].id]);renderHand()")
    west.locator("#returnBtn").click()
    west.locator("#cfmGo").click()
    for page in pages:
        page.wait_for_function("()=>G.phase==='prep' && G.clock.who==='prep' && G.trib.every(x=>x.rc)")
    assert host.evaluate(SNAP) == east.evaluate(SNAP) == west.evaluate(SNAP)
    assert host.evaluate("G.hands.every(h=>h.length===27) && new Set(G.hands.flat().map(c=>c.id)).size===108")
    assert not errors and not blocked, (errors, blocked)
    print(json.dumps({"contexts":3,"viewports":viewports,"earlyReturnBeforeOtherChoice":True,
        "confirmationHidesOnlyLocalSummary":True,"guestRecoveryBeforeOtherTribute":True,
        "samePhysicalHands":True,"physicalCards":108,"sortingClockAfterBothTransfers":True,
        "collectorRequests":0,"pageErrors":errors}))
    host.evaluate("forgetHost()")
    browser.close()
