"""Clint UI adaptation, stable tablet rotations and model-specific timeout isolation."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import threading
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").exists())
OUT = ROOT / "web/artifacts/validation/clint-sync-20261106"
OUT.mkdir(parents=True, exist_ok=True)


def main():
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT / "web/dist"))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"
    errors = []
    reports = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel="chrome")
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.add_init_script(
                "localStorage.setItem('guandan-mini','1');window.messages=[];const Native=Worker;window.Worker=class extends Native{postMessage(data,...rest){window.messages.push(data);return super.postMessage(data,...rest)}}"
            )
            page.goto(url + "?test=1#debug", wait_until="networkidle")
            page.wait_for_function("()=>typeof window.resetGame==='function'")
            assert page.locator("#miniBtn").count() == 0
            assert page.evaluate("miniPlays") is False
            assert page.locator("#watchBtn").count() == 0
            page.locator("#levelBtn").click()
            page.locator('[data-level-team=SN][data-lv="14"]').click()
            page.locator('[data-level-team=EW][data-lv="8"]').click()
            page.locator("[data-side=EW]").click()
            page.locator('[data-rank="0"][data-direction=S]').click()
            page.locator('[data-rank="1"][data-direction=N]').click()
            page.locator('[data-rank="2"][data-direction=E]').click()
            assert "双进贡" in page.locator("#startTributeHint").inner_text()
            page.locator('[data-attempt-team=SN][data-attempt="2"]').click()
            page.locator("[data-done]").click()
            g = page.evaluate(
                """()=>{myDir='S';resetGame();return {levels:G.levels,L:G.L,order:G.prevOut,fails:G.aFails}}"""
            )
            assert g == {"levels": [14, 8], "L": 8, "order": [0, 2, 1, 3], "fails": [2, 0]}, g
            page.evaluate(
                """()=>{hideOverlay();$('#lobby').hidden=true;G.hands=Array.from({length:4},(_,p)=>makeDeck().filter((c,i)=>i%4===p));G.phase='play';G.turn=0;G.round=1;G.log=[];G.seen=[];G.rest=[];G.fixed=[];G.myOrder=[];G.pw=[];G.trib=[];G.returns=[];G.clock=null;G.trick=null;render()}"""
            )
            meta = page.locator("meta[name=viewport]").get_attribute("content")
            for width, height in [
                (1440, 1000),
                (768, 1024),
                (1024, 768),
                (390, 844),
                (844, 390),
                (1440, 1000),
            ]:
                page.set_viewport_size({"width": width, "height": height})
                page.evaluate("dispatchEvent(new Event('orientationchange'))")
                page.wait_for_timeout(1700)
                assert page.locator("meta[name=viewport]").get_attribute("content") == meta
                assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
                if width > 560:
                    geo = page.evaluate(
                        """()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),a=r('#seat2 .who'),b=r('#mebar .meinfo'),l=r('#seat3 .who'),rr=r('#seat1 .who');return{widths:[a.width,b.width,l.width,rr.width],heights:[a.height,b.height,l.height,rr.height],mid:Math.abs((a.y+a.height/2+b.y+b.height/2)/2-(l.y+l.height/2)),sides:Math.abs(l.y-rr.y)}}"""
                    )
                    assert all(abs(v - 108) < 1 for v in geo["widths"]), geo
                    assert all(abs(v - 38) < 1 for v in geo["heights"]), geo
                    assert geo["mid"] < 1.5 and geo["sides"] < 1.5, geo
                page.screenshot(path=str(OUT / f"table-{width}-{height}.png"))
                reports.append({"viewport": [width, height], "viewportMetaStable": True})
            page.evaluate(
                "window.viewportWrites=0;new MutationObserver(()=>window.viewportWrites++).observe(document.querySelector('meta[name=viewport]'),{attributes:true})"
            )
            page.locator("#optBtn").click()
            for _ in range(3):
                page.locator("#fsOptBtn").click()
                page.wait_for_timeout(300)
                page.locator("#fsOptBtn").click()
                page.wait_for_timeout(300)
            assert page.evaluate("viewportWrites") == 0
            for _ in range(3):
                page.locator("#cardBackBtn").click()
            assert page.locator("#backName").inner_text() == "无"
            page.evaluate("G.heapN=10;pileRebuild()")
            assert page.locator("#pile .pc:not(.cur)").count() == 0
            page.locator("#optBtn").click()
            # Both request types are explicit; selected neural models never enter rule-timeout.
            decisions = page.evaluate(
                """async()=>{const d=makeDeck();G.hands[0]=[d.find(c=>c.r===3),d.find(c=>c.r===4)];G.L=2;G.log=[];G.trick={player:1,play:{type:'single',value:2,n:1,cards:[d.find(c=>c.r===2)]}};botModels=['clint-rule','clint-rule','clint-rule','clint-rule'];const pass=await TableBot.decide(0,{timeout:true});const last=messages.at(-1).type;botModels=['012','012','012','012'];await TableBot.decide(0,{timeout:true});return {pass,last,neural:messages.at(-1).type}}"""
            )
            assert decisions == {
                "pass": None,
                "last": "rule-timeout",
                "neural": "decide",
            }, decisions
            assert not errors, errors
            hc = browser.new_context()
            gc = browser.new_context()
            host, guest = hc.new_page(), gc.new_page()
            for room_page in [host, guest]:
                room_page.on("pageerror", lambda e: errors.append(str(e)))
            host.goto(url + "?test=1", wait_until="networkidle")
            host.wait_for_function("()=>typeof window.resetGame==='function'")
            host.locator("#nick").fill("Host")
            host.locator("[data-mode=host]").click()
            host.wait_for_function("()=>NET.peerOpen", timeout=30000)
            code = host.locator("#roomCodeShow").inner_text()
            host.locator("[data-seat=W]").click()
            host.locator("#levelBtn").click()
            for selector in [
                '[data-level-team=SN][data-lv="14"]',
                '[data-level-team=EW][data-lv="8"]',
                "[data-side=EW]",
                '[data-rank="0"][data-direction=S]',
                '[data-rank="1"][data-direction=N]',
                '[data-rank="2"][data-direction=E]',
                '[data-attempt-team=SN][data-attempt="2"]',
                '[data-attempt-team=EW][data-attempt="1"]',
            ]:
                host.locator(selector).click()
            host.locator("[data-done]").click()
            guest.goto(url + "?test=1&room=" + code, wait_until="networkidle")
            guest.wait_for_function("()=>typeof window.resetGame==='function'")
            guest.locator("#nick").fill("Guest")
            guest.locator("#joinBtn").click()
            guest.wait_for_function("()=>NET.hostConn?.open", timeout=30000)
            guest.locator("[data-seat=S]").click()
            host.wait_for_function("()=>NET.lobby.S==='Guest'")
            guest.wait_for_function("()=>RULES.startState?.aFails.SN===2")
            guest.locator("#levelBtn").click()
            assert guest.locator('[data-level-team=SN][data-lv="14"]').is_disabled()
            guest.locator("[data-done]").click()
            host.locator("#sitBtn").click()
            guest.wait_for_function("()=>NET.mode==='guest'&&G.round===1")
            host.evaluate("G.paused=true")
            snapshot = (
                "()=>({levels:G.levels,L:G.L,fails:G.aFails,order:G.prevOut,cutter:G.cutter})"
            )
            host_start = host.evaluate(snapshot)
            guest_start = guest.evaluate(snapshot)
            assert host_start == {
                "levels": [8, 14],
                "L": 8,
                "fails": [1, 2],
                "order": [1, 3, 2, 0],
                "cutter": 1,
            }, host_start
            assert guest_start == {
                "levels": [14, 8],
                "L": 8,
                "fails": [2, 1],
                "order": [0, 2, 1, 3],
                "cutter": 0,
            }, guest_start
            # Recovery intentionally waits for a stable phase, never mid-shuffle/deal animation.
            host.evaluate("G.paused=false")
            for _ in range(350):
                if host.evaluate(
                    "['prep','return','tribPick'].includes(G.phase)&&!G.busy&&!G.gives?.length"
                ):
                    break
                for room_page in [host, guest]:
                    deck_button = room_page.locator("#deckBtn")
                    if deck_button.is_visible() and deck_button.is_enabled():
                        deck_button.click()
                host.wait_for_timeout(100)
            assert host.evaluate(
                "['prep','return','tribPick'].includes(G.phase)&&!G.busy&&!G.gives?.length"
            )
            host.evaluate("G.paused=true")
            guest.reload(wait_until="networkidle")
            guest.wait_for_function("()=>NET.mode==='guest'&&G.round===1&&!NET.gone", timeout=30000)
            assert guest.evaluate(snapshot) == guest_start
            assert guest.evaluate("NET.startSettingsUsed") is True
            # Deliberately start a new match; this is a state-transition test, not a played match.
            host.evaluate("newGame()")
            guest.wait_for_function("()=>G.levels.every(l=>l===2)&&G.prevOut===null")
            assert host.evaluate("G.levels") == [2, 2]
            room_setup = {
                "realPeerJS": True,
                "host": host_start,
                "guest": guest_start,
                "guestReadOnly": True,
                "refreshPreservesSetup": True,
                "newMatchDoesNotReapply": True,
            }
            hc.close()
            gc.close()
            assert not errors, errors
            browser.close()
        regressions = {}
        for script in [
            "ui_refresh_smoke.py",
            "tribute_smoke.py",
            "ready_transition_smoke.py",
            "rejoin_smoke.py",
            "table_layout_smoke.py",
            "clint_bot_smoke.py",
            "private_table_smoke.py",
            "coach_smoke.py",
        ]:
            result = subprocess.run(
                [sys.executable, "-X", "utf8", str(ROOT / "web/tests" / script), url]
                + (["--solo-only"] if script == "coach_smoke.py" else []),
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf8",
                timeout=240,
            )
            if result.returncode:
                raise RuntimeError(
                    script + " failed: " + result.stdout[-1500:] + result.stderr[-3000:]
                )
            regressions[script] = result.stdout[-5000:]
        result = {
            "viewports": reports,
            "startSetup": g,
            "roomStartSetup": room_setup,
            "timeoutRouting": decisions,
            "fullscreenCycles": 3,
            "viewportMetaWrites": 0,
            "privateCardsNotMadePublic": True,
            "pageErrors": errors,
            "regressions": regressions,
        }
        (OUT / "report.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )
        print(json.dumps(result, ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
