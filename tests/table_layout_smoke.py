"""Real practice entry and learned turns, followed by explicit layout stress fixtures."""

import json
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "work/validation/table-layout"
OUT.mkdir(parents=True, exist_ok=True)
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/") + "?test=1"


def rect(page, selector):
    return page.locator(selector).bounding_box()


def same_spot(a, b):
    assert a and b
    assert all(abs(a[key] - b[key]) < 1 for key in ["x", "y", "width", "height"]), (a, b)


def dock_clear(page):
    boxes = page.evaluate("""() => [...document.querySelectorAll(
      '#fixBtn,#splitBtn,#sortBtn,#undoBtn,#hintBtn,#clearBtn,#playBtn,#passBtn,#goBtn')]
      .filter(e=>e.offsetWidth&&!e.hidden&&getComputedStyle(e).visibility!=='hidden')
      .map(e=>({id:e.id,...e.getBoundingClientRect().toJSON()}))""")
    width, height = page.viewport_size.values()
    for box in boxes:
        assert box["x"] >= 0 and box["y"] >= 0
        assert box["right"] <= width and box["bottom"] <= height
    for i, a in enumerate(boxes):
        for b in boxes[i + 1 :]:
            assert min(a["right"], b["right"]) <= max(a["x"], b["x"]) or min(
                a["bottom"], b["bottom"]
            ) <= max(a["y"], b["y"]), (a, b)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    errors, checks = [], []
    for width, height, touch in [(1440, 1000, False), (1280, 720, False), (1024, 768, True)]:
        context = browser.new_context(viewport={"width": width, "height": height}, has_touch=touch)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL, wait_until="networkidle")
        page.locator("#practiceBtn").click()
        page.locator("#practiceStart").click()
        for _ in range(250):
            if page.locator("#readyBtn").is_visible():
                break
            deck = page.locator("#deckBtn")
            if deck.is_visible() and deck.is_enabled():
                deck.click()
            page.wait_for_timeout(80)
        ready = rect(page, "#readyBtn")
        assert ready and ready["height"] >= (44 if touch else 36)
        assert page.locator(".cnt").all_text_contents() == ["27张"] * 4
        page.locator("#readyBtn").click()
        page.wait_for_function("G.phase==='play'")
        saw_continue = False
        for _ in range(300):
            if page.evaluate("G.log.length>=6"):
                break
            if page.locator("#goBtn").is_visible():
                same_spot(ready, rect(page, "#goBtn"))
                saw_continue = True
                page.locator("#goBtn").click()
            elif page.evaluate("G.turn===0"):
                page.locator("#hintBtn").click()
                if page.locator("#playBtn").is_enabled():
                    page.locator("#playBtn").click()
                elif page.locator("#passBtn").is_enabled():
                    page.locator("#passBtn").click()
            page.wait_for_timeout(80)
        assert page.evaluate("G.log.length>=6")
        assert saw_continue
        dock_clear(page)
        play_slot = rect(page, "#playBtn")
        page.evaluate(
            "document.querySelector('#playBtn').hidden=true;document.querySelector('#returnBtn').hidden=false;placeActionBtns()"
        )
        same_spot(play_slot, rect(page, "#returnBtn"))
        page.evaluate("renderControls()")
        page.screenshot(path=str(OUT / f"table-{width}.png"))
        page.evaluate("window.layoutBefore=structuredClone(G)")
        old_size = page.locator(".tpb").evaluate("e=>e.style.getPropertyValue('--mcw')")
        # Repeated public rows are a synthetic overflow fixture, never sent to the model.
        page.evaluate("""() => {const row=G.log.find(x=>x.cards);
          G.log=Array.from({length:100},(_,i)=>({...row,p:i%4,lead:i%4===0}));practicePlays()}""")
        assert page.locator(".tpb").evaluate("e=>e.scrollHeight>e.clientHeight")
        assert old_size == page.locator(".tpb").evaluate("e=>e.style.getPropertyValue('--mcw')")
        page.locator(".tpb").evaluate("e=>e.scrollTop=0")
        assert page.locator(".tpb").evaluate("e=>e.scrollTop===0")
        page.evaluate("""() => {G.rest=[{p:1,cards:makeDeck().slice(0,27)}];practicePlays()}""")
        assert page.locator(".tpb .tq.rest .mc").count() == 27
        assert page.locator(".tpb").evaluate("e=>e.scrollWidth<=e.clientWidth+1")
        assert page.locator(".tpb .tq.rest .mc").evaluate_all(
            "es=>es.every(e=>Math.abs(e.getBoundingClientRect().width-parseFloat(getComputedStyle(e).getPropertyValue('--mcw')))<1)"
        )
        page.evaluate("Object.assign(G,structuredClone(layoutBefore));render()")
        plate = rect(page, "#mebar .meinfo")
        # An explicit finished-player fixture checks controls without asking a bot to play invalid cards.
        page.evaluate("""() => {G.tok++;G.hands[0]=[];G.fixed=[];G.out=[0];G.reveal=1;
          G.turn=-1;G.stepWait=1;render();layoutHand()}""")
        same_spot(ready, rect(page, "#goBtn"))
        same_spot(plate, rect(page, "#mebar .meinfo"))
        assert page.locator("#undoBtn").is_visible()
        assert page.locator("#goBtn").evaluate(
            "e=>document.elementFromPoint(e.getBoundingClientRect().x+10,e.getBoundingClientRect().y+10).closest('button')===e"
        )
        dock_clear(page)
        page.evaluate("Object.assign(G,structuredClone(layoutBefore));render();practiceNoteEdit(1)")
        note = rect(page, "#tnbox")
        assert note and note["x"] == 8 and note["width"] <= 280
        assert note["y"] + note["height"] <= height
        page.screenshot(path=str(OUT / f"note-{width}.png"))
        page.locator("#tnNo").click()
        page.evaluate("""() => {G.phase='roundEnd';G.out=[0,2,1,3];G.reveal=4;
          G.result={team:0,up:3,before:2,after:5,aTeam:0,order:G.out};
          G.levels=[5,2];G.lvlTeam=0;render();showResult()}""")
        same_spot(ready, rect(page, "#nextBtn"))
        panel = rect(page, "#panel")
        assert panel["x"] == 8 and panel["width"] <= 280
        assert page.locator("#nextBtn").evaluate(
            "e=>document.elementFromPoint(e.getBoundingClientRect().x+10,e.getBoundingClientRect().y+10).closest('button')===e"
        )
        page.screenshot(path=str(OUT / f"result-{width}.png"))
        checks.append(
            {
                "viewport": [width, height],
                "touch": touch,
                "learnedTurns": len(page.evaluate("layoutBefore.log")),
                "sameActionSlot": True,
                "readableScrollablePlays": True,
                "finishedPlayerControls": True,
                "compactNotesAndResults": True,
            }
        )
        context.close()
    assert not errors, errors
    report = {
        "checks": checks,
        "pageErrors": errors,
        "fixtureScope": "Overflow, finished-player and result geometry use synthetic display states; six opening turns per viewport use the real learned policy.",
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
    browser.close()
