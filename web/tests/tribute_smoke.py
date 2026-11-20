"""Returning while an animation is in progress must preserve every physical card."""

import json, sys
from playwright.sync_api import expect, sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
URL += ("&" if "?" in URL else "?") + "test=1"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.context.route(
        "https://guandan-human-games-collector.couple-ledger-service.workers.dev/**",
        lambda route: route.abort(),
    )
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_function("() => typeof window.hideOverlay === 'function'")
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
        expect(page.locator("#tribBox")).to_be_visible()
        page.locator("#returnBtn").click()
        expect(page.locator("#tribBox")).to_be_hidden()
        expect(page.locator("#cfmGo")).to_be_visible()
        expect(page.locator("#returnBtn")).to_be_disabled()
        assert page.evaluate("G.returns.length") == 1
        page.locator("#cfmNo").click()
        expect(page.locator("#cfmGo")).to_be_hidden()
        expect(page.locator("#tribBox")).to_be_visible()
        page.locator("#returnBtn").click()
        page.locator("#cfmGo").click()
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
    payment_viewports = [(1440, 1000), (844, 390), (390, 844)]
    for width, height in payment_viewports:
        page.set_viewport_size({"width": width, "height": height})
        selected = page.evaluate("""()=>{
          resetGame();
          const deck=makeDeck(), own=deck.filter(card=>card.r>=11&&card.r<=14).slice(0,27);
          const held=new Set(own.map(card=>card.id)), rest=deck.filter(card=>!held.has(card.id));
          G.hands=[own,rest.slice(0,27),rest.slice(27,54),rest.slice(54)];
          G.round=2;G.L=2;G.prevOut=[1,2,3,0];G.gives=[];G.returns=[];
          doTribute();
          const choice=tribOptions(0)[0].id;
          sel=new Set([choice]);renderHand();
          return choice;
        }""")
        assert page.evaluate("G.clock.total") == 60000
        assert page.evaluate("G.tribPick[0] == null")
        page.locator("#returnBtn").click()
        expect(page.locator("#cfmGo")).to_have_text("确认进贡")
        assert page.evaluate("G.tribPick[0] == null")
        page.locator("#cfmGo").scroll_into_view_if_needed()
        expect(page.locator("#cfmGo")).to_be_in_viewport()
        page.locator("#cfmGo").click()
        assert page.evaluate("G.tribPick[0]") == selected
        assert page.evaluate("new Set(G.hands.flat().map(card=>card.id)).size") == 108

    for width, height in payment_viewports:
        page.set_viewport_size({"width": width, "height": height})
        for last_hand, option, shape, needs_confirmation in [
            (False, False, "bomb", True), (False, False, "straight-flush", True),
            (True, False, "bomb", False), (False, True, "single", True),
        ]:
            page.evaluate("""([last,option,shape])=>{
              resetGame();const deck=makeDeck();
              const cards=shape==='bomb' ? deck.filter(c=>c.r===3).slice(0,4)
                : shape==='straight-flush' ? [3,4,5,6,7].map(r=>deck.find(c=>c.r===r&&c.s==='S'))
                : [deck.find(c=>c.r===3)];
              G.hands=[last ? cards : [...cards,deck.find(c=>c.r===14)],deck.slice(40,52),
                       deck.slice(55,66),deck.slice(68,76)];
              Object.assign(G,{phase:'play',turn:0,leader:0,round:2,L:2,log:[],seen:[],rest:[],pw:[]});
              confirmPlay=option;cfm=null;
              sel=new Set(cards.map(card=>card.id));render();
            }""", [last_hand, option, shape])
            page.locator("#playBtn").click()
            if needs_confirmation:
                expect(page.locator("#cfmGo")).to_have_text("确认出牌")
                expect(page.locator("#playBtn")).to_be_disabled()
                page.evaluate("onPlay();onPlay()")
                assert page.evaluate("G.log.length") == 0
                expect(page.locator("#cfmGo")).to_be_in_viewport()
                page.locator("#cfmNo").click()
                expect(page.locator("#playBtn")).to_be_enabled()
                page.locator("#playBtn").click()
                page.locator("#cfmGo").click()
            assert page.evaluate("G.log.length") == 1
            expect(page.locator("#cfmGo")).to_be_hidden()

    for count in (3, 4):
        page.evaluate("""count=>{
          resetGame();
          const deck=makeDeck();
          G.hands=[deck.slice(0,count),deck.slice(40,49),deck.slice(50,59),deck.slice(60,69)];
          G.phase='play';G.round=2;G.L=2;G.turn=0;G.leader=1;G.log=[];G.seen=[];G.rest=[];G.pw=[];
          const cards=[3,4,5,6,7].map(rank=>deck.find(card=>card.r===rank&&card.s!=='H'));
          G.trick={player:1,play:genPlays(cards,2).find(play=>play.n===5)};
          startTurn();
        }""", count)
        assert page.evaluate("hints.length") == 0
        page.wait_for_timeout(1050)
        assert page.evaluate("G.log.length") == int(count == 3)
    assert not errors, errors
    print(json.dumps({
        "returnCases": reports,
        "paymentPreviewViewports": payment_viewports,
        "tributeClockMs": 60000,
        "autoPassThreeButNotFour": True,
        "leadBombAndStraightFlushConfirmation": True,
        "lastHandExemptsMandatoryConfirmation": True,
        "pageErrors": errors,
    }))
    browser.close()
