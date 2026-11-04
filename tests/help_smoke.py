"""Scannable help, native modal focus, paused solo clocks and pending learned moves."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "work/validation/help"
OUT.mkdir(parents=True, exist_ok=True)
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/") + "?test=1"
SETUP = """()=>{hideOverlay();$('#lobby').hidden=true;resetGame();const d=makeDeck();G.hands=[[],[],[],[]];d.forEach((card,i)=>G.hands[i%4].push(card));G.phase='play';G.turn=0;G.L=2;G.round=1;G.log=[];G.seen=[];G.rest=[];G.fixed=[];G.myOrder=[];G.pw=[];G.trib=[];G.returns=[];NET.mode='solo';NET.off=0;setHumans([0]);startTurn()}"""
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    reports = []
    for width, height in [(1440, 1000), (390, 844), (844, 390)]:
        page = browser.new_page(viewport={"width": width, "height": height})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="networkidle")
        page.locator("#lobbyHelpBtn").click()
        page.locator("#rulesDialog").wait_for(state="visible")
        page.keyboard.press("Escape")
        assert page.evaluate("document.activeElement.id") == "lobbyHelpBtn"
        page.evaluate(SETUP)
        if width == 1440:
            page.evaluate("RULES.trib=false;RULES.aFail='keep'")
        page.locator("#rulesBtn").click()
        if width == 1440:
            assert "本场不进贡" in page.locator("#rulesPane").inner_text()
            assert "打 A 不限次数" in page.locator("#rulesPane").inner_text()
        before = page.evaluate("G.clock.left")
        page.wait_for_timeout(500)
        assert abs(page.evaluate("G.clock.left") - before) < 20
        page.locator("#operationsTab").click()
        assert page.locator("#operationsTab").get_attribute("aria-selected") == "true"
        assert page.locator("#rulesPane").is_hidden()
        page.keyboard.press("p")
        assert page.evaluate("sel.size") == 0
        page.locator("#operationsPane").focus()
        page.keyboard.press("PageDown")
        rect = page.locator("#rulesDialog").bounding_box()
        assert (
            rect["x"] >= 0
            and rect["y"] >= 0
            and rect["x"] + rect["width"] <= width + 1
            and rect["y"] + rect["height"] <= height + 1
        )
        assert not page.evaluate("document.documentElement.scrollWidth>innerWidth")
        page.screenshot(path=str(OUT / f"help-{width}.png"))
        page.keyboard.press("Escape")
        assert page.evaluate("document.activeElement.id") == "rulesBtn"
        page.wait_for_timeout(250)
        assert page.evaluate("G.clock.left") < before - 100
        assert not errors, errors
        reports.append(
            {
                "width": width,
                "height": height,
                "lobbyHelp": True,
                "tabsAndKeyboard": True,
                "soloClockPaused": True,
                "responsive": True,
                "pageErrors": errors,
            }
        )
        page.close()
    page = browser.new_page()
    page.goto(URL, wait_until="networkidle")
    page.evaluate(SETUP)
    page.evaluate("G.turn=1;G.clock=null")
    page.locator("#rulesBtn").click()
    page.evaluate("void TableBot.playTurn({who:1})")
    page.wait_for_function("TableBot.ready", timeout=60000)
    page.wait_for_timeout(500)
    assert page.evaluate("G.log.length") == 0
    page.locator("#helpClose").click()
    page.wait_for_function("G.log.length>0", timeout=15000)
    page.evaluate(SETUP)
    page.evaluate("NET.mode='host'")
    page.locator("#rulesBtn").click()
    before = page.evaluate("G.clock.left")
    page.wait_for_timeout(350)
    assert page.evaluate("G.clock.left") < before - 100
    assert "朋友房间继续计时" in page.locator("#helpTiming").inner_text()
    page.locator("#helpClose").click()
    practice = browser.new_page()
    practice.goto(URL, wait_until="networkidle")
    practice.locator("#practiceBtn").click()
    practice.locator("#practiceStart").click()
    for _ in range(200):
        if practice.evaluate("G.phase==='prep'"):
            break
        button = practice.locator("#deckBtn")
        if button.is_visible() and button.is_enabled():
            button.click()
        practice.wait_for_timeout(100)
    practice.evaluate("G.phase='play';G.turn=-1;G.stepWait=1;G.clock=null")
    practice.locator("#rulesBtn").click()
    assert "明牌练习没有玩家计时" in practice.locator("#helpTiming").inner_text()
    practice.locator("#rulesPane p").first.click()
    assert practice.evaluate("G.stepWait") == 1 and practice.evaluate("G.turn") == -1
    report = {
        "viewports": reports,
        "pendingPolicyWaitsForHelpClose": True,
        "currentHouseRulesShown": True,
        "multiplayerClockContinues": True,
        "practiceHelpDoesNotAdvanceTurn": True,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    browser.close()
