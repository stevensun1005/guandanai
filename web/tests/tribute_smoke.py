"""Returning while an animation is in progress must preserve every physical card."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
URL += ("&" if "?" in URL else "?") + "test=1"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL, wait_until="networkidle")
    reports = []
    for high_only in [False, True]:
        page.evaluate(
            """high=>{
          hideOverlay();document.querySelector('#lobby').hidden=true;resetGame();
          const deck=makeDeck(),own=high ? deck.filter(card=>card.r>=11&&card.r<=14).slice(0,28) : deck.slice(0,28);
          const held=new Set(own.map(card=>card.id)),rest=deck.filter(card=>!held.has(card.id));
          G.hands=[own,rest.slice(0,26),rest.slice(26,53),rest.slice(53)];
          G.phase='prep';G.round=2;G.L=2;G.turn=0;G.leader=0;G.log=[];G.seen=[];G.rest=[];G.pw=[];
          G.myOrder=[];G.fixed=[];G.retPick={};G.returns=[{from:0,to:1}];G.ready=[];
          G.trib=[{g:1,r:0,tc:own.at(-1)}];G.kang=null;G.gives=[];G.clock={who:'prep',left:90000,total:90000};render();
        }""",
            high_only,
        )
        legal = page.evaluate("""()=>{
          let pool=G.hands[0].filter(card=>card.r<=10&&!isWild(card,G.L));
          if(!pool.length){const options=G.hands[0].filter(card=>!isWild(card,G.L));const low=Math.min(...options.map(card=>val(card,G.L)));pool=options.filter(card=>val(card,G.L)===low);}
          const ids=pool.map(card=>card.id);if(!ids.includes(aiReturnCard(G.hands[0],G.L).id))throw Error('illegal automated return');
          return ids;
        }""")
        assert legal
        if high_only:
            assert "最小" in page.locator("#selectionStatus").inner_text()
        else:
            page.evaluate("sel=new Set([G.hands[0].find(card=>card.r===12).id]);renderHand()")
            page.locator("#returnBtn").click()
            assert page.evaluate("G.returns.length") == 1
        page.evaluate("id=>{sel=new Set([id]);renderHand()}", legal[0])
        assert "可以还贡" in page.locator("#selectionStatus").inner_text()
        page.locator("#returnBtn").click()
        assert page.evaluate("G.hands.map(hand=>hand.length)") == [27, 27, 27, 27]
        assert page.evaluate("new Set(G.hands.flat().map(card=>card.id)).size") == 108
        page.locator("#readyBtn").click()
        page.wait_for_function("() => (G.phase==='play')")
        assert page.evaluate("G.hands.map(hand=>hand.length)") == [27, 27, 27, 27]
        page.wait_for_timeout(2100)
        assert page.evaluate("new Set(G.hands.flat().map(card=>card.id)).size") == 108
        assert not errors, errors
        reports.append(
            {
                "highOnly": high_only,
                "automatedReturnLegal": True,
                "immediateHandCounts": [27, 27, 27, 27],
                "readyDuringFlightSafe": True,
            }
        )
    print(json.dumps({"cases": reports, "pageErrors": errors}))
    browser.close()
