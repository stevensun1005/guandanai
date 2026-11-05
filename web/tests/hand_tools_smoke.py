"""Exercise sorting, grouping and undo through the visible controls."""

from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
URL += ("&" if "?" in URL else "?") + "test=1"
OUT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file()) / "web/artifacts/validation/hand-tools"
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    reports = []
    for width, height, mobile in [(1440, 1000, False), (390, 844, True), (844, 390, True)]:
        page = browser.new_page(
            viewport={"width": width, "height": height}, is_mobile=mobile, has_touch=mobile
        )
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL, wait_until="networkidle")
        page.locator("#nick").fill("理牌测试")
        page.locator('[data-seat="S"]').click()
        page.locator("#sitBtn").click()
        for _ in range(250):
            if page.locator("#readyBtn").is_visible():
                break
            button = page.locator("#deckBtn")
            if button.is_visible() and button.is_enabled():
                button.click()
            page.wait_for_timeout(100)
        page.locator("#readyBtn").wait_for(state="visible")
        original = page.evaluate("G.hands[0].map(c=>c.id).sort((a,b)=>a-b)")
        # Group a known selection using the real button, then sort only loose cards.
        page.evaluate("sel=new Set(G.hands[0].slice(0,3).map(c=>c.id));renderHand()")
        page.locator("#fixBtn").click()
        group = page.evaluate("JSON.stringify(G.fixed)")
        before = page.evaluate("JSON.stringify(G.myOrder)")
        for mode in ["suit", "rank", "smart"]:
            page.locator("#sortBtn").click()
            menu = page.locator("#handToolsMenu")
            assert menu.is_visible()
            box = menu.bounding_box()
            assert box["x"] >= 0 and box["y"] >= 0
            assert box["x"] + box["width"] <= width + 1 and box["y"] + box["height"] <= height + 1
            page.locator(f'[data-hand-tool="{mode}"]').click()
            assert page.evaluate("JSON.stringify(G.fixed)") == group
            assert page.evaluate("G.fixed.flat().concat(G.myOrder).sort((a,b)=>a-b)") == original
        page.locator("#sortBtn").click()
        page.locator('[data-hand-tool="release"]').click()
        assert page.evaluate("G.fixed.length") == 0
        page.locator("#sortBtn").click()
        page.locator('[data-hand-tool="undo"]').click()
        assert page.evaluate("JSON.stringify(G.fixed)") == group
        page.locator("#sortBtn").click()
        assert page.locator("#handRedoOrder").is_enabled()
        page.locator("#handRedoOrder").click()
        assert page.evaluate("G.fixed.length") == 0
        page.keyboard.press("Control+z")
        assert page.evaluate("JSON.stringify(G.fixed)") == group
        page.keyboard.press("Control+Shift+z")
        assert page.evaluate("G.fixed.length") == 0
        page.keyboard.press("Control+z")
        assert page.evaluate("JSON.stringify(G.fixed)") == group
        page.locator("#sortBtn").click()
        assert page.locator("#handRedoOrder").is_enabled()
        page.keyboard.press("Control+y")
        assert page.locator("#handRedoOrder").is_disabled()
        assert page.locator("#handUndoOrder").is_enabled()
        page.keyboard.press("Escape")
        assert page.evaluate("G.fixed.length") == 0
        page.keyboard.press("Control+z")
        assert page.evaluate("JSON.stringify(G.fixed)") == group
        page.locator("#sortBtn").click()
        page.keyboard.press("Escape")
        assert page.locator("#handToolsMenu").is_hidden()
        assert page.locator("#sortBtn").get_attribute("aria-expanded") == "false"
        assert not page.evaluate("document.documentElement.scrollWidth>innerWidth")
        assert not errors, errors
        page.screenshot(path=str(OUT / f"hand-{width}.png"))
        reports.append(
            {
                "width": width,
                "height": height,
                "sorts": 3,
                "groupPreserved": True,
                "undo": True,
                "redoAndShortcuts": True,
                "pageErrors": errors,
            }
        )
        page.close()
    (OUT / "report.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")
    print(json.dumps(reports))
    browser.close()
