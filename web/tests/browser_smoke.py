"""Browser ONNX parity, no inference API, and two real PeerJS clients."""

import json
from pathlib import Path
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
import numpy as np
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT))
from ai.danMCai.reference.numpy_engine import PolicyNetwork, encode, cards_array

OUT = ROOT / "web/artifacts/validation/browser-release"
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
parts = urlsplit(URL)
query = dict(parse_qsl(parts.query))
query["test"] = "1"
URL = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def main():
    model = PolicyNetwork()
    states = json.loads((ROOT / "ai/shared/fixtures/positions.json").read_text())
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(
            viewport={"width": 1440, "height": 1000},
            permissions=["clipboard-read", "clipboard-write"],
        )
        context.add_init_script("localStorage.setItem('guandan-ai','rules')")
        context.add_init_script("""const NativeWorker=Worker;window.modelDecisions=0;
          window.Worker=class extends NativeWorker{postMessage(data,...rest){if(data.type==='decide'&&data.state?.modelId)window.modelDecisions++;return super.postMessage(data,...rest)}};""")
        host = context.new_page()
        errors = []
        api = []
        host.on("pageerror", lambda error: errors.append(str(error)))
        host.on(
            "request", lambda request: api.append(request.url) if "/api/" in request.url else None
        )
        host.goto(URL, wait_until="networkidle")
        host.wait_for_function("() => (typeof TableBot==='object')")
        assert not host.evaluate("TableBot.ready")
        host.evaluate("TableBot.check()")
        host.wait_for_function('() => (TableBot.ready)', timeout=90000)
        assert host.locator("#aiStatus,#aiTableStatus,[data-ai-mode],.ai-panel").count() == 0
        assert "AI" not in host.locator("#lobby").inner_text()
        host.screenshot(path=str(OUT / "lobby-desktop.png"))
        # Exact weights, independently encoded by NumPy, evaluated inside a real Worker.
        results = []
        for state in states[:: max(1, len(states) // 16)]:
            answer = host.evaluate(
                """state=>new Promise((resolve,reject)=>{
              const w=new Worker(new URL('./assets/ai-worker.mjs',document.baseURI),{type:'module'});
              w.onmessage=({data})=>{w.terminate();if(data.error)reject(Error(data.error));else resolve(data.result)};
              w.onerror=e=>reject(Error(e.message));w.postMessage({id:1,type:'decide',state});
            })""",
                {**state, "modelId": "001"},
            )
            batch = np.array(
                [np.concatenate((encode(state), cards_array(a))) for a in state["actions"]],
                dtype=np.float32,
            )
            values = model.values(batch)
            best = int(np.argmax(values))
            assert answer["index"] == best, (answer, best, values)
            assert abs(answer["value"] - float(values[best])) < 2e-4
            results.append(answer)
        assert not api, api
        # Two independent browser clients use the public PeerJS signalling service.
        host.locator("#nick").fill("房主")
        host.locator('[data-mode="host"]').click()
        try:
            host.wait_for_function('() => (NET.peerOpen===true)', timeout=25000)
        except Exception:
            status = host.locator("#lobbyStatus").inner_text()
            raise AssertionError("PeerJS room creation failed: " + status)
        code = host.locator("#roomCodeShow").inner_text()
        host.evaluate("() => {aiDecide=()=>{throw Error('Unexpected classic decision')}}")
        host.locator('[data-seat="S"]').click()
        host.locator("#botStyleBox summary").click()
        host.locator('[data-bot-seat="E"]').select_option("001")
        host.locator('[data-bot-seat="W"]').select_option("001")
        host.locator("#shareRoomBtn").click()
        invite = host.evaluate("navigator.clipboard.readText()")
        assert f"room={code}" in invite
        guest_context = browser.new_context(viewport={"width": 1280, "height": 800})
        guest_models = []
        guest_context.on(
            "request",
            lambda request: guest_models.append(request.url) if "/models/" in request.url else None,
        )
        guest = guest_context.new_page()
        guest.on("pageerror", lambda error: errors.append(str(error)))
        guest.goto(invite, wait_until="networkidle")
        assert host.locator('meta[name="app-version"]').get_attribute("content") == guest.locator(
            'meta[name="app-version"]'
        ).get_attribute("content"), "preview was rebuilt during the test"
        assert guest.locator("#roomCode").input_value() == code
        guest.locator("#nick").fill("朋友")
        guest.locator("#joinBtn").click()
        guest.wait_for_function('() => (NET.hostConn&&NET.hostConn.open)', timeout=25000)
        guest.wait_for_function("() => (document.querySelector('[data-bot-seat=E]').value==='001')")
        assert guest.locator('[data-bot-seat="E"]').is_disabled()
        guest.locator('[data-seat="N"]').click()
        host.wait_for_function("() => (NET.lobby.N==='朋友')", timeout=10000)
        host.locator("#sitBtn").click()
        host.wait_for_function("() => (NET.mode==='host')")
        guest.wait_for_function("() => (NET.mode==='guest')")
        assert host.evaluate("botModels")[1::2] == ["001", "001"]
        assert guest.evaluate("botModels") == host.evaluate("botModels")
        assert not guest.evaluate("TableBot.ready")
        assert not guest_models, guest_models
        assert guest.locator("#aiTableStatus,[data-ai-mode]").count() == 0
        # Normal shuffle/cut/deal, including a human's action crossing the connection.
        for _ in range(250):
            if host.evaluate("G.phase==='prep'") and guest.evaluate("G.phase==='prep'"):
                break
            for page in (host, guest):
                button = page.locator("#deckBtn")
                if button.is_visible() and button.is_enabled():
                    button.click()
            host.wait_for_timeout(100)
        assert host.evaluate("G.phase==='prep'"), host.evaluate("G.phase")
        host.locator("#readyBtn").click()
        guest.locator("#readyBtn").click()
        host.wait_for_function("() => (G.phase==='play')", timeout=15000)
        guest.wait_for_function("() => (G.phase==='play')", timeout=15000)
        # Trigger human timeouts in this smoke game; bots use their real worker.
        for _ in range(180):
            if host.evaluate("G.log.length>=12"):
                break
            host.evaluate(
                "if(G.clock&&typeof G.clock.who==='number'&&G.clock.think==null)G.clock.left=1"
            )
            host.wait_for_timeout(100)
        assert host.evaluate("G.log.length>=12")
        assert host.evaluate("modelDecisions") > 0
        host.wait_for_timeout(350)
        host_log = host.evaluate(
            "JSON.stringify(G.log.map(e=>({p:e.p,cards:e.cards?.map(c=>c.id)||null})))"
        )
        guest_log = guest.evaluate(
            "JSON.stringify(G.log.map(e=>({p:toAbs(e.p),cards:e.cards?.map(c=>c.id)||null})))"
        )
        assert json.loads(host_log) == json.loads(guest_log), "host and guest diverged"
        host.screenshot(path=str(OUT / "multiplayer-host.png"))
        guest.screenshot(path=str(OUT / "multiplayer-guest.png"))
        guest_context.close()
        host.wait_for_function('() => (NET.humans.size===1)', timeout=25000)
        mobile = browser.new_page(
            viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True
        )
        mobile.goto(URL, wait_until="networkidle")
        mobile.wait_for_function("() => (typeof TableBot==='object')")
        mobile.evaluate("TableBot.check()")
        mobile.wait_for_function('() => (TableBot.ready)', timeout=60000)
        mobile.screenshot(path=str(OUT / "lobby-mobile.png"))
        assert not mobile.evaluate("document.documentElement.scrollWidth>innerWidth")
        # Failed resource loading waits for a retry instead of changing bot strategy.
        failure_context = browser.new_context()
        failure_context.route("**/models/*.onnx*", lambda route: route.abort())
        failure = failure_context.new_page()
        failure.on("pageerror", lambda error: errors.append(str(error)))
        failure.goto(URL, wait_until="networkidle")
        failure.wait_for_function("() => (typeof startPlay==='function')")
        failure.evaluate("""() => {
          aiDecide=()=>{throw Error('Unexpected classic decision')};
          hideOverlay();$('#lobby').hidden=true;resetGame();
          const deck=makeDeck();G.hands=[[],[],[],[]];
          deck.forEach((card,i)=>G.hands[i%4].push(card));
          G.L=2;G.round=1;G.log=[];G.seen=[];G.pw=[];G.rest=[];
          G.myOrder=[];G.fixed=[];G.trib=[];G.kang=null;startPlay(1);
        }""")
        failure.locator("#retryTableBtn").wait_for(state="visible", timeout=25000)
        assert failure.evaluate("G.log.length") == 0
        failure_context.unroute("**/models/*.onnx*")
        failure.locator("#retryTableBtn").click()
        failure.wait_for_function('() => (G.log.length>=1)', timeout=60000)
        failure_context.close()
        assert not errors, errors
        report = {
            "browserModelParityPositions": len(results),
            "maxValueError": "< 0.0002",
            "inferenceApiRequests": len(api),
            "roomCreated": True,
            "inviteLink": True,
            "twoClientsPlayed": True,
            "logsSynchronized": True,
            "guestDisconnectHandled": True,
            "legacySettingIgnored": True,
            "modelRetryWithoutFallback": True,
            "hiddenModelControls": True,
            "pageErrors": errors,
        }
        report["botModelsSynchronized"] = True
        report["guestAvoidsModelDownload"] = True
        report["numberedModelDecisions"] = host.evaluate("modelDecisions")
        (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))
        browser.close()


if __name__ == "__main__":
    main()
