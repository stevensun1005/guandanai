"""Card focus must select without accidentally passing; P submits the selected play."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
URL += ("&" if "?" in URL else "?") + "test=1"
OUT = Path(__file__).resolve().parents[1] / "work/validation/selection"
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
        page.locator("#nick").fill("牌友")
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
        assert page.locator('#hand [role="button"]').count() == 27
        assert page.locator('#hand [tabindex="0"]').count() == 1
        # Set a following turn with no advancing clock; the hand and controls stay real.
        page.evaluate("""()=>{
          const card=makeDeck().find(card=>card.r===3&&card.s==='S');
          const source=G.hands.findIndex(hand=>hand.some(held=>held.id===card.id));
          if(source!==1){const swap=G.hands[1][0];G.hands[1][0]=card;G.hands[source]=G.hands[source].map(held=>held.id===card.id ? swap : held);}
          const play={...analyze([card],G.L)[0],cards:[card]};
          G.hands[1]=G.hands[1].filter(held=>held.id!==card.id);
          G.phase='play';G.turn=0;G.clock=null;G.trick={player:1,play};G.passes=2;
          G.seen=[card];G.log=[{p:1,...play,lead:true},{p:2,cards:null},{p:3,cards:null}];
          G.last=[null,{play},'pass','pass'];G.trickPlays=[{p:1,play}];startTurn();G.clock=null;renderClocks();
        }""")
        prior = page.evaluate("G.log.length")
        first = page.locator("#hand .card").first
        first.focus()
        first.press("Space")
        assert page.evaluate("G.log.length") == prior
        assert first.get_attribute("aria-pressed") == "true"
        assert "已选 1 张" in page.locator("#selectionStatus").inner_text()
        first.press("Enter")
        assert page.evaluate("sel.size") == 0
        first.press("ArrowRight")
        assert page.locator("#hand .card").nth(1).evaluate("el=>el===document.activeElement")
        page.keyboard.press("End")
        assert page.locator("#hand .card").last.evaluate("el=>el===document.activeElement")
        page.keyboard.press("Space")
        page.keyboard.press("Escape")
        assert page.evaluate("sel.size") == 0
        if not mobile:
            before = page.evaluate("JSON.stringify({fixed:G.fixed,order:G.myOrder})")
            visible_point = """selector=>{
              for(const card of document.querySelectorAll(selector)){
                const r=card.getBoundingClientRect();
                for(const fx of [.2,.5,.8])for(const fy of [.2,.5,.8]){
                  const x=r.left+r.width*fx,y=r.top+r.height*fy;
                  if(document.elementFromPoint(x,y)?.closest('#hand .card')===card)return {x,y};
                }
              }
            }"""
            point = page.evaluate(visible_point, "#hand .card")
            assert point
            page.mouse.click(point["x"], point["y"])
            page.wait_for_timeout(140)
            point = page.evaluate(visible_point, "#hand .card.sel")
            assert point
            page.mouse.move(point["x"], point["y"])
            page.mouse.down()
            assert (
                page.evaluate("G.log.length") == prior
            ), "second press must wait for release before a double-tap play"
            page.mouse.move(point["x"] + 90, point["y"] + 30, steps=8)
            assert page.evaluate("!!mv?.active"), page.evaluate("({phase:G.phase,mv})")
            page.keyboard.press("Escape")
            page.mouse.up()
            assert page.evaluate("JSON.stringify({fixed:G.fixed,order:G.myOrder})") == before
        page.evaluate(
            "sel=new Set(G.hands[0].filter(c=>!isWild(c,G.L)).filter((c,i,all)=>i===0||c.r!==all[0].r).slice(0,2).map(c=>c.id));renderHand()"
        )
        assert "不成牌型" in page.locator("#selectionStatus").inner_text()
        page.locator("#selectionClear").click()
        assert page.evaluate("sel.size") == 0
        page.keyboard.press("h")
        assert page.evaluate("sel.size") > 0
        assert "可以出牌" in page.locator("#selectionStatus").inner_text()
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / f"selected-{width}.png"))
        if not mobile:
            page.locator("#optBtn").click()
            page.locator("#confirmBtn").click()
            page.locator("#selectionStatus").click()
            page.keyboard.press("p")
            assert page.evaluate("G.log.length") == prior
            assert "再次出牌确认" in page.locator("#selectionStatus").inner_text()
        page.keyboard.press("p")
        page.wait_for_function("G.log.length>3")
        assert page.evaluate("G.log[3].p") == 0
        assert not page.evaluate("document.documentElement.scrollWidth>innerWidth")
        assert not errors, errors
        reports.append(
            {
                "width": width,
                "height": height,
                "keyboardSelection": True,
                "spaceDidNotPass": True,
                "selectionFeedback": True,
                "keyboardPlay": True,
                "pageErrors": errors,
            }
        )
        page.close()
    print(json.dumps(reports))
    browser.close()
