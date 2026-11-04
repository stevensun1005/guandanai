"""Four real PeerJS clients play multiple rounds, including tribute and one host timeout."""

from pathlib import Path
import json, sys, time
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "work/validation/multiround"
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
URL += ("&" if "?" in URL else "?") + "test=1"
TARGET = int(sys.argv[2]) if len(sys.argv) > 2 else 3
HUMANS = int(sys.argv[3]) if len(sys.argv) > 3 else 4
REJOIN = "--rejoin" in sys.argv[4:]
MATCH = "--match" in sys.argv[4:]
AUTO = "--auto" in sys.argv[4:]
if HUMANS not in (2, 4):
    raise ValueError("Use two or four human clients")
OUT = ROOT / (
    "work/validation/full-match"
    if MATCH
    else "work/validation/multiround-mixed"
    if HUMANS == 2
    else "work/validation/multiround"
)
specified_output = next(
    (arg.split("=", 1)[1] for arg in sys.argv[4:] if arg.startswith("--output=")), None
)
if specified_output:
    OUT = ROOT / specified_output
OUT.mkdir(parents=True, exist_ok=True)
snapshot = """()=>({round:G.round,phase:G.phase,L:G.L,
 levels:[G.levels[NET.off%2],G.levels[(NET.off+1)%2]],
 hands:Array.from({length:4},(_,seat)=>G.hands[toLocal(seat)].concat((G.rest||[]).filter(rest=>rest.p===toLocal(seat)).flatMap(rest=>rest.cards)).map(card=>card.id).sort((a,b)=>a-b)),
 log:G.log.map(entry=>({p:toAbs(entry.p),cards:entry.cards?.map(card=>card.id).sort((a,b)=>a-b)||null})),
 out:G.out.map(toAbs)})"""
status = """()=>{
 const all=G.hands.flat().map(card=>card.id).concat((G.log||[]).flatMap(entry=>entry.cards?.map(card=>card.id)||[]),(G.rest||[]).flatMap(rest=>rest.cards.map(card=>card.id)));
 return {phase:G.phase,round:G.round,turn:G.turn,log:G.log?.length||0,count:all.length,unique:new Set(all).size,syncs:NET.syncCount||0};
}"""
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    contexts = []
    pages = []
    errors = []
    reports = []
    refreshed = set()
    rejoin_reports = []
    models = []
    for _ in range(HUMANS):
        context = browser.new_context(
            viewport={"width": 1280, "height": 850},
            permissions=["clipboard-read", "clipboard-write"],
        )
        contexts.append(context)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        pages.append(page)
    contexts[0].add_init_script(
        """const BaseWorker=Worker;window.policyDecisions=0;window.lastPolicyInput=null;window.lastPolicyMessage=null;
window.Worker=class extends BaseWorker {
 constructor(...args){super(...args);this.addEventListener('message',event=>window.lastPolicyMessage=event.data)}
 postMessage(data,...rest){if(data.type==='decide'){window.policyDecisions++;window.lastPolicyInput=structuredClone(data.state)}return super.postMessage(data,...rest)}
};"""
    )
    host = pages[0]
    host.on(
        "request", lambda request: models.append(request.url) if "/models/" in request.url else None
    )
    host.goto(URL, wait_until="networkidle")
    host.locator("#nick").fill("房主")
    host.locator('[data-mode="host"]').click()
    host.wait_for_function("NET.peerOpen", timeout=30000)
    code = host.locator("#roomCodeShow").inner_text()
    host.locator('[data-seat="W"]').click()
    for page, direction, name in zip(pages[1:], ["S", "E", "N"], ["一号", "二号", "三号"]):
        page.goto(URL + "&room=" + code, wait_until="networkidle")
        page.locator("#nick").fill(name)
        page.locator("#joinBtn").click()
        page.wait_for_function("NET.hostConn?.open", timeout=30000)
        page.locator(f'[data-seat="{direction}"]').click()
        host.wait_for_function("NET.lobby." + direction + "!==null")
    if HUMANS == 2:
        host.locator("#botStyleBox summary").click()
        host.locator("[data-bot-seat=E]").select_option("observant")
        host.locator("[data-bot-seat=N]").select_option("adaptive")
    host.locator("#sitBtn").click()
    for page in pages:
        page.wait_for_function("NET.started||NET.mode==='guest'", timeout=15000)
    if HUMANS == 4:
        assert not host.evaluate(
            "TableBot.ready"
        ), "four human seats should not predownload the model"
    forced = False
    timeout_completed = False
    rounds = 0
    started = time.monotonic()
    last_progress = started
    match_finished = False
    last_action = None
    last_action_at = started
    latest_clients = []
    while rounds < TARGET and time.monotonic() - started < (3600 if MATCH else 900):
        for page in pages:
            page.evaluate(
                """()=>{if(window.tracedGame===G)return;window.tracedGame=G;window.turnTrace=[];const game=G;let value=G.turn;Object.defineProperty(G,'turn',{enumerable:true,configurable:true,get(){return value},set(next){window.turnTrace.push({from:value,to:next,log:game.log?.length,phase:game.phase,stack:Error().stack});if(window.turnTrace.length>120)window.turnTrace.shift();value=next}})}"""
            )
        states = [page.evaluate(status) for page in pages]
        action = (states[0]["round"], states[0]["phase"], states[0]["log"])
        if action != last_action:
            last_action = action
            last_action_at = time.monotonic()
        if (
            errors
            or time.monotonic() - last_action_at > 35
            or host.locator("#retryTableBtn").is_visible()
        ):
            diagnostic = host.evaluate(
                """()=>({game:G,policyInput:lastPolicyInput,policyMessage:lastPolicyMessage,clock:G.clock,paused:G.paused,panel:document.querySelector('#panel').textContent,error:localStorage.getItem('guandan-lastError'),ready:TableBot.ready,humans:[...NET.humans],mode:NET.mode})"""
            )
            diagnostic["clients"] = [
                page.evaluate(
                    """()=>({game:G,inbox:NET.inbox,off:NET.off,mode:NET.mode,gone:NET.gone,pending:NET.pending,error:localStorage.getItem('guandan-lastError'),panel:document.querySelector('#panel').textContent,turnTrace:window.turnTrace})"""
                )
                for page in pages
            ]
            (OUT / "stalled-position.json").write_text(
                json.dumps(diagnostic, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            host.screenshot(path=str(OUT / "stalled.png"))
            raise AssertionError(
                {
                    "stalled": states,
                    "clock": diagnostic["clock"],
                    "error": diagnostic["error"],
                    "panel": diagnostic["panel"],
                }
            )
        if len({state["round"] for state in states}) == 1 and all(
            state["phase"] in ["play", "roundEnd", "over"] for state in states
        ):
            owners = [
                page.evaluate(
                    """()=>Array.from({length:4},(_,seat)=>{const p=toLocal(seat);return G.hands[p].concat(G.log.filter(entry=>entry.p===p).flatMap(entry=>entry.cards||[]),(G.rest||[]).filter(entry=>entry.p===p).flatMap(entry=>entry.cards)).map(card=>card.id).sort((a,b)=>a-b)})"""
                )
                for page in pages
            ]
            if any(owner != owners[0] for owner in owners[1:]):
                diagnostic = {
                    "states": states,
                    "owners": owners,
                    "clients": [
                        page.evaluate(
                            """()=>({game:G,inbox:NET.inbox,off:NET.off,error:localStorage.getItem('guandan-lastError'),turnTrace:window.turnTrace})"""
                        )
                        for page in pages
                    ],
                }
                (OUT / "ownership-divergence.json").write_text(
                    json.dumps(diagnostic, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                raise AssertionError("dealt/returned ownership diverged")
        for state in states:
            if state["phase"] not in ["start", "shuffle", "cut", "deal"]:
                assert state["count"] == 108 and state["unique"] == 108, (
                    "card conservation",
                    states,
                )
        if REJOIN and states[0]["phase"] == "prep" and states[0]["round"] not in refreshed:
            index = 1 + (states[0]["round"] - 1) % (HUMANS - 1)
            returning = pages[index]
            returning.reload(wait_until="networkidle")
            returning.wait_for_function(
                "NET.mode==='guest'&&!NET.gone&&G.phase!=='start'", timeout=35000
            )
            host.wait_for_function("count=>NET.humans.size===count", arg=HUMANS, timeout=15000)
            refreshed.add(states[0]["round"])
            rejoin_reports.append(
                {
                    "round": states[0]["round"],
                    "offset": returning.evaluate("NET.off"),
                    "phase": "prep",
                }
            )
            continue
        if all(state["phase"] in ["roundEnd", "over"] for state in states):
            if REJOIN and not any(item["phase"] == "roundEnd" for item in rejoin_reports):
                returning = pages[-1]
                returning.reload(wait_until="networkidle")
                returning.wait_for_function(
                    "NET.mode==='guest'&&!NET.gone&&['roundEnd','over'].includes(G.phase)",
                    timeout=35000,
                )
                host.wait_for_function("count=>NET.humans.size===count", arg=HUMANS, timeout=15000)
                rejoin_reports.append(
                    {
                        "round": states[0]["round"],
                        "offset": returning.evaluate("NET.off"),
                        "phase": "roundEnd",
                    }
                )
            snaps = [page.evaluate(snapshot) for page in pages]
            assert all(snap == snaps[0] for snap in snaps[1:]), ("round divergence", snaps)
            rounds += 1
            reports.append(
                {
                    "round": snaps[0]["round"],
                    "moves": len(snaps[0]["log"]),
                    "levels": snaps[0]["levels"],
                    "allClientsEqual": True,
                }
            )
            print(json.dumps(reports[-1]), flush=True)
            match_finished = all(state["phase"] == "over" for state in states)
            if rounds >= TARGET or (MATCH and match_finished):
                break
            for page in pages:
                page.locator("#nextBtn").wait_for(state="visible", timeout=15000)
                if page.locator("#nextBtn").is_enabled():
                    page.locator("#nextBtn").click()
            host.wait_for_function("!['roundEnd','over'].includes(G.phase)", timeout=15000)
            continue
        for page, state in zip(pages, states):
            button = page.locator("#deckBtn")
            if button.is_visible() and button.is_enabled():
                button.click()
            if state["phase"] in ["prep", "return", "tribPick"]:
                returning = page.locator("#returnBtn")
                if returning.is_visible() and returning.is_enabled():
                    page.evaluate("""()=>{
                      let cards;
                      if(G.phase==='tribPick')cards=tribOptions(0);
                      else {cards=G.hands[0].filter(card=>card.r<=10&&!isWild(card,G.L));
                        if(!cards.length){const pool=G.hands[0].filter(card=>!isWild(card,G.L));const low=Math.min(...pool.map(card=>val(card,G.L)));cards=pool.filter(card=>val(card,G.L)===low);}}
                      if(cards.length){sel=new Set([cards[0].id]);renderHand();}
                    }""")
                    returning.click()
                ready = page.locator("#readyBtn")
                if ready.is_visible() and ready.is_enabled():
                    ready.click()
        if states[0]["phase"] == "play" and not forced:
            host.evaluate("if(G.clock)G.clock.left=1")
            forced = True
        if forced and not timeout_completed:
            timeout_completed = host.evaluate("G.log.length>0")
            if timeout_completed:
                assert host.evaluate("TableBot.ready")
        if AUTO and states[0]["phase"] == "play":
            host.evaluate("if(G.clock)G.clock.left=1")
        if timeout_completed and not AUTO:
            for page in pages:
                if page.evaluate("G.phase==='play'&&G.turn===0"):
                    if page.locator("#hintBtn").is_enabled():
                        page.locator("#hintBtn").click()
                    if page.locator("#playBtn").is_enabled():
                        page.locator("#playBtn").click()
                    elif page.locator("#passBtn").is_enabled():
                        page.locator("#passBtn").click()
        if time.monotonic() - last_progress > 30:
            print(
                json.dumps({"progress": states[0], "elapsed": round(time.monotonic() - started)}),
                flush=True,
            )
            last_progress = time.monotonic()
        host.wait_for_timeout(60)
    assert match_finished if MATCH else rounds == TARGET, (
        "timeout",
        reports,
        [page.evaluate(status) for page in pages],
    )
    assert not errors, errors
    for page in pages[1:]:
        assert not page.evaluate("TableBot.ready")
    if HUMANS == 2:
        assert any(
            "response.onnx" in url for url in models
        ), "mixed game did not exercise the auxiliary network"
    host.screenshot(path=str(OUT / "final-host.png"))
    report = {
        "clients": HUMANS,
        "completedMatch": match_finished,
        "finalResult": host.evaluate("G.result"),
        "acceleratedTurnTimeouts": AUTO,
        "policyDecisions": host.evaluate("policyDecisions"),
        "automaticStateResyncs": [page.evaluate("NET.syncCount||0") for page in pages],
        "pageVersion": host.locator("meta[name=app-version]").get_attribute("content"),
        "bots": 4 - HUMANS,
        "botStyles": ["observant", "adaptive"] if HUMANS == 2 else [],
        "hostDirection": "W",
        "rounds": reports,
        "cardConservation": True,
        "realGuestActions": True,
        "hostTimeoutUsedLearnedPolicy": timeout_completed,
        "guestsAvoidModelDownload": True,
        "rejoins": rejoin_reports,
        "auxiliaryModelLoaded": any("response.onnx" in url for url in models),
        "pageErrors": errors,
        "elapsedSeconds": time.monotonic() - started,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report), flush=True)
    browser.close()
