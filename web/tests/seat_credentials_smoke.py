"""Former seat holders and explicitly departed players cannot reclaim another player's seat."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/") + "?test=1"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    errors = []
    hc = browser.new_context()
    host = hc.new_page()
    host.on("pageerror", lambda e: errors.append(str(e)))
    host.goto(URL, wait_until="networkidle")
    host.locator("#nick").fill("房主")
    host.locator("[data-mode=host]").click()
    host.wait_for_function('() => (NET.peerOpen)', timeout=30000)
    code = host.locator("#roomCodeShow").inner_text()
    host.locator("[data-seat=S]").click()

    def join(name, direction):
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL + "&room=" + code, wait_until="networkidle")
        page.locator("#nick").fill(name)
        page.locator("#joinBtn").click()
        page.wait_for_function('() => (NET.hostConn?.open)', timeout=30000)
        page.locator(f"[data-seat={direction}]").click()
        host.wait_for_function(
            "({direction,name})=>NET.lobby[direction]===name",
            arg={"direction": direction, "name": name},
        )
        page.wait_for_function("() => (sessionStorage.getItem('guandan-rejoin-seat')!==null)")
        return (
            context,
            page,
            page.evaluate("JSON.parse(sessionStorage.getItem('guandan-rejoin-seat'))"),
        )

    old, _, old_token = join("旧玩家", "E")
    old.close()
    host.wait_for_function('() => (NET.lobby.E===null)', timeout=30000)
    current, guest, current_token = join("新玩家", "E")
    guest.evaluate("NET.hostConn.send({t:'sit',dir:'E',name:'新玩家',ver:'old-build'})")
    host.wait_for_function("() => (document.querySelector('#sitBtn').disabled)")
    guest.evaluate("sendSit('E')")
    host.wait_for_function("() => (!document.querySelector('#sitBtn').disabled)")
    temporary, _, host_seat_token = join("临时", "N")
    temporary.close()
    host.wait_for_function('() => (NET.lobby.N===null)', timeout=30000)
    host.locator("[data-seat=N]").click()
    host.locator("#sitBtn").click()
    host.wait_for_function("() => (NET.mode==='host')", timeout=15000)
    guest.wait_for_function("() => (NET.mode==='guest')", timeout=15000)

    def rejected(credential):
        context = browser.new_context()
        context.add_init_script(
            'sessionStorage.setItem("guandan-rejoin-seat",'
            + json.dumps(json.dumps(credential))
            + ")"
        )
        page = context.new_page()
        page.goto(URL + "&room=" + code, wait_until="networkidle")
        try:
            page.wait_for_function('() => (NET.refused)', timeout=30000)
        except Exception as error:
            raise AssertionError(
                {
                    "visitor": page.evaluate(
                        "({mode:NET.mode,phase:G.phase,refused:NET.refused,connected:!!NET.hostConn?.open,status:document.querySelector('#lobbyStatus').textContent})"
                    ),
                    "host": host.evaluate(
                        "({mode:NET.mode,started:NET.started,humans:NET.humans.size,connections:NET.conns.size})"
                    ),
                }
            ) from error
        assert page.evaluate("NET.mode==='solo'&&G.phase==='start'")
        context.close()

    rejected(old_token)
    rejected(host_seat_token)
    assert host.evaluate("NET.humans.size") == 2
    guest.locator("#quitBtn").click()
    guest.locator("#quitYes").click()
    guest.wait_for_function(
        "() => (document.querySelector('#lobby')&&!document.querySelector('#lobby').hidden)", timeout=15000
    )
    host.wait_for_function('() => (NET.humans.size===1)', timeout=15000)
    assert guest.evaluate("sessionStorage.getItem('guandan-rejoin-seat')") == None
    rejected(current_token)
    assert host.evaluate("NET.humans.size") == 1
    assert not errors, errors
    report = {
        "pageVersionMismatchBlocksStart": True,
        "replacedSeatTokenRevoked": True,
        "hostSeatCannotBeTaken": True,
        "explicitExitClearsCredential": True,
        "explicitExitRevokesHostCredential": True,
        "pageErrors": errors,
    }
    (ROOT / "web/artifacts/validation/seat-credentials.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    browser.close()
