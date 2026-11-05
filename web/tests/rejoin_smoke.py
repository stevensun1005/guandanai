"""Real seat credentials, refresh recovery, interrupted inference and rejected unknown visitors."""

from pathlib import Path
import json, sys, time
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
OUT = ROOT / "web/artifacts/validation/rejoin"
OUT.mkdir(parents=True, exist_ok=True)
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/") + "?test=1"
SNAP = """()=>({round:G.round,phase:G.phase,L:G.L,levels:[G.levels[NET.off%2],G.levels[(NET.off+1)%2]],hands:Array.from({length:4},(_,seat)=>G.hands[toLocal(seat)].map(card=>card.id).sort((a,b)=>a-b)),log:G.log.map(entry=>({p:toAbs(entry.p),cards:entry.cards?.map(card=>card.id).sort((a,b)=>a-b)||null}))})"""
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    errors = []
    hc = browser.new_context(viewport={"width": 1280, "height": 850})
    gc = browser.new_context(viewport={"width": 1280, "height": 850})
    hc.add_init_script("""const OriginalWorker=Worker;window.delayNextReply=false;window.awaitingReply=false;
 window.Worker=class extends OriginalWorker{constructor(...args){super(...args);this.addEventListener('message',event=>{if(window.delayNextReply&&Number.isInteger(event.data.result?.index)){window.delayNextReply=false;window.awaitingReply=true;event.stopImmediatePropagation();setTimeout(()=>{window.awaitingReply=false;this.onmessage?.(event)},2200)}})}};""")
    host = hc.new_page()
    guest = gc.new_page()
    guest_models = []
    for page in [host, guest]:
        page.on("pageerror", lambda error: errors.append(str(error)))
    guest.on(
        "request",
        lambda request: guest_models.append(request.url) if "/models/" in request.url else None,
    )
    host.goto(URL, wait_until="networkidle")
    host.locator("#nick").fill("房主")
    host.locator("[data-mode=host]").click()
    host.wait_for_function('() => (NET.peerOpen)', timeout=30000)
    code = host.locator("#roomCodeShow").inner_text()
    host.locator("[data-seat=W]").click()
    guest.goto(URL + "&room=" + code, wait_until="networkidle")
    guest.locator("#nick").fill("朋友")
    guest.locator("#joinBtn").click()
    guest.wait_for_function('() => (NET.hostConn?.open)', timeout=30000)
    guest.locator("[data-seat=S]").click()
    host.wait_for_function("() => (NET.lobby.S==='朋友')")
    guest.wait_for_function("() => (sessionStorage.getItem('guandan-rejoin-seat')!==null)")
    credential = guest.evaluate("JSON.parse(sessionStorage.getItem('guandan-rejoin-seat'))")
    host.locator("#sitBtn").click()
    for _ in range(250):
        if host.evaluate("G.phase==='prep'") and guest.evaluate("G.phase==='prep'"):
            break
        for page in [host, guest]:
            button = page.locator("#deckBtn")
            if button.is_visible() and button.is_enabled():
                button.click()
        host.wait_for_timeout(100)
    assert host.evaluate("G.phase==='prep'")
    guest.reload(wait_until="networkidle")
    guest.wait_for_function("() => (NET.mode==='guest'&&G.phase==='prep'&&!NET.gone)", timeout=30000)
    host.wait_for_function('() => (NET.humans.size===2)', timeout=10000)
    assert guest.evaluate("NET.off") == 1
    assert host.evaluate(SNAP) == guest.evaluate(SNAP)
    assert (
        guest.evaluate("JSON.parse(sessionStorage.getItem('guandan-rejoin-seat')).token")
        == credential["token"]
    )
    host.locator("#readyBtn").click()
    guest.locator("#readyBtn").click()
    host.wait_for_function("() => (G.phase==='play')")
    # Reach the guest's actual turn using normal human UI actions.
    for _ in range(300):
        if host.evaluate("G.phase==='play'&&G.turn===1&&!!G.clock"):
            break
        if host.evaluate("G.phase==='play'&&G.turn===0"):
            host.locator("#hintBtn").click()
            if host.locator("#playBtn").is_enabled():
                host.locator("#playBtn").click()
            elif host.locator("#passBtn").is_enabled():
                host.locator("#passBtn").click()
        host.wait_for_timeout(80)
    host.evaluate("delayNextReply=true;G.clock.left=1")
    host.wait_for_function('() => (awaitingReply)', timeout=20000)
    before = host.evaluate("G.log.length")
    guest.reload(wait_until="networkidle")
    guest.wait_for_function("() => (NET.mode==='guest'&&G.phase==='play'&&!NET.gone)", timeout=30000)
    host.wait_for_function('() => (NET.humans.has(1))', timeout=10000)
    host.wait_for_timeout(2600)
    assert (
        host.evaluate("G.log.length") == before
    ), "stale in-flight computer action committed after player returned"
    assert host.evaluate(SNAP) == guest.evaluate(SNAP)
    # The returned player can send a real play or pass again.
    guest.locator("#hintBtn").click()
    if guest.locator("#playBtn").is_enabled():
        guest.locator("#playBtn").click()
    else:
        guest.locator("#passBtn").click()
    host.wait_for_function("before=>G.log.length>before", arg=before, timeout=10000)
    # A real data channel close also restores without reloading the page.
    guest.evaluate("NET.hostConn.close()")
    guest.wait_for_function('() => (NET.gone)', timeout=10000)
    guest.wait_for_function("() => (NET.mode==='guest'&&!NET.gone&&NET.hostConn?.open)", timeout=35000)
    host.wait_for_function('() => (NET.humans.size===2)', timeout=10000)
    # An unrelated tab has no credential and cannot take any occupied or bot seat mid-game.
    outsider = browser.new_context()
    page = outsider.new_page()
    page.goto(URL + "&room=" + code, wait_until="networkidle")
    page.locator("#nick").fill("访客")
    page.locator("#joinBtn").click()
    page.wait_for_function('() => (NET.refused)', timeout=15000)
    assert page.evaluate("NET.mode==='solo'&&G.phase==='start'")
    assert host.evaluate("NET.humans.size") == 2
    assert not guest_models, guest_models
    host.locator("#quitBtn").click()
    host.locator("#quitYes").click()
    guest.wait_for_function(
        "() => (document.querySelector('#reconnectMessage')?.textContent.includes('房主已退出'))",
        timeout=15000,
    )
    assert guest.locator("#reconnectBtn").is_disabled()
    guest.locator("#soloOnBtn").click()
    assert guest.evaluate("NET.mode==='solo'&&NET.off===0")
    solo_before = guest.evaluate("G.log.length")
    for _ in range(300):
        if guest.evaluate("before=>G.log.length>before", solo_before):
            break
        guest.evaluate("if(G.clock)G.clock.left=1")
        guest.wait_for_timeout(100)
    assert guest.evaluate("TableBot.ready")
    assert guest.evaluate("before=>G.log.length>before", solo_before)
    assert any("policy.onnx" in url for url in guest_models)

    assert not errors, errors
    guest.screenshot(path=str(OUT / "recovered-guest.png"))
    report = {
        "hostDirection": "W",
        "guestDirection": "S",
        "refreshDuringPrep": True,
        "refreshDuringInFlightPolicy": True,
        "stalePolicyCancelled": True,
        "realGuestActionAfterReturn": True,
        "dataChannelAutomaticRecovery": True,
        "unknownSeatRejected": True,
        "sameCredential": True,
        "guestAvoidsModelDownload": True,
        "hostExitOffersSoloContinuation": True,
        "soloContinuationLoadsLearnedPolicy": True,
        "pageErrors": errors,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    browser.close()
