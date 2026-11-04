"""An authenticated guest recovers a blocked event queue on the same connection without extra turn time."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/") + "?test=1"
SNAP = """()=>({round:G.round,L:G.L,hands:Array.from({length:4},(_,seat)=>G.hands[toLocal(seat)].map(card=>card.id).sort((a,b)=>a-b)),log:G.log.map(entry=>({p:toAbs(entry.p),cards:entry.cards?.map(card=>card.id)||null}))})"""
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    hc = browser.new_context()
    gc = browser.new_context()
    host = hc.new_page()
    guest = gc.new_page()
    errors = []
    for page in [host, guest]:
        page.on("pageerror", lambda error: errors.append(str(error)))
    host.goto(URL, wait_until="networkidle")
    host.locator("#nick").fill("房主")
    host.locator("[data-mode=host]").click()
    host.wait_for_function("NET.peerOpen", timeout=30000)
    code = host.locator("#roomCodeShow").inner_text()
    host.locator("[data-seat=W]").click()
    guest.goto(URL + "&room=" + code, wait_until="networkidle")
    guest.locator("#nick").fill("朋友")
    guest.locator("#joinBtn").click()
    guest.wait_for_function("NET.hostConn?.open", timeout=30000)
    guest.locator("[data-seat=S]").click()
    host.wait_for_function("NET.lobby.S==='朋友'")
    host.locator("#sitBtn").click()
    for _ in range(250):
        if host.evaluate("G.phase==='prep'") and guest.evaluate("G.phase==='prep'"):
            break
        for page in [host, guest]:
            button = page.locator("#deckBtn")
            if button.is_visible() and button.is_enabled():
                button.click()
        host.wait_for_timeout(100)
    host.locator("#readyBtn").click()
    guest.locator("#readyBtn").click()
    host.wait_for_function("G.phase==='play'&&G.clock&&NET.humans.has(G.turn)", timeout=20000)
    peer = guest.evaluate("NET.peer.id")
    before = host.evaluate("G.log.length")
    guest.evaluate("G.turn=-1;G.clock=null")
    host.evaluate("G.clock.left=1")
    host.wait_for_function("before=>G.log.length>before", arg=before, timeout=20000)
    host.wait_for_function("G.phase==='play'&&G.clock&&NET.humans.has(G.turn)", timeout=15000)
    left = host.evaluate("G.clock.left")
    guest.wait_for_function("NET.syncCount>0", timeout=20000)
    assert guest.evaluate("NET.peer.id") == peer
    assert host.evaluate("G.clock.left") <= left + 100
    assert host.evaluate(SNAP) == guest.evaluate(SNAP)
    assert not guest.evaluate("TableBot.ready")
    actor = host if host.evaluate("G.turn===0") else guest
    actor.locator("#hintBtn").click()
    if actor.locator("#playBtn").is_enabled():
        actor.locator("#playBtn").click()
    else:
        actor.locator("#passBtn").click()
    host.wait_for_function(
        "count=>G.log.length>count", arg=len(host.evaluate(SNAP)["log"]) - 1, timeout=10000
    )
    assert not errors, errors
    report = {
        "blockedQueueResynchronized": True,
        "sameConnection": True,
        "hostClockNotExtended": True,
        "matchingHandsAndLog": True,
        "guestAvoidsModelDownload": True,
        "pageErrors": errors,
    }
    (ROOT / "work/validation/resync.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    browser.close()
