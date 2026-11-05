"""Public-only scorecards, keyboard isolation, downloads and responsive modal."""

from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
OUT = ROOT / "web/artifacts/validation/public-history"
OUT.mkdir(parents=True, exist_ok=True)
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/") + "?test=1"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    reports = []
    for width, height in [(1440, 1000), (390, 844), (844, 390)]:
        context = browser.new_context(
            viewport={"width": width, "height": height},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL, wait_until="networkidle")
        page.evaluate("""()=>{
   hideOverlay();$('#lobby').hidden=true;resetGame();const d=makeDeck();
   G.hands=[d.slice(2),[],[],[]];G.log=[{p:0,type:'single',value:2,n:1,cards:[d[0]],lead:true},{p:1,cards:null},{p:2,type:'single',value:3,n:1,cards:[d[1]]}];
   G.phase='play';G.turn=0;G.round=3;G.L=2;G.trick=null;G.clock=null;G.fixed=[];G.myOrder=[];G.pw=[];G.seen=[d[0],d[1]];G.rest=[];
   myNick='牌友';NAMES=['你','朋友甲','<img src=x onerror=alert(1)>','朋友丙'];render();
   G.roundHistory=[{round:2,L:3,levels:[3,3],names:['牌友','朋友甲','朋友乙','朋友丙'],log:[{p:1,cards:[d[2]],type:'single',lead:true},{p:2,cards:null}],result:{team:1,up:2,before:2,after:4,order:[1,0,3,2],aTeam:1}}];
  }""")
        page.locator("#optBtn").click()
        page.locator("#historyBtn").click()
        page.locator("#publicHistory").wait_for(state="visible")
        assert page.locator("#publicHistoryList li").count() == 3
        assert page.locator("#publicHistoryList img").count() == 0
        assert "<img src=x" in page.locator("#publicHistoryList").inner_text()
        page.locator("#publicHistoryCopy").focus()
        page.keyboard.press("p")
        assert page.evaluate("G.log.length") == 3
        page.locator("#publicHistoryFilter").select_option("1")
        assert page.locator("#publicHistoryList li").count() == 1
        assert page.locator("#publicHistoryList li").get_attribute("value") == "2"
        page.locator("#publicHistoryFilter").select_option("all")
        page.evaluate("G.log.push({p:3,cards:null});render()")
        assert page.locator("#publicHistoryList li").count() == 4
        page.locator("#publicHistoryCopy").click()
        text = page.evaluate("navigator.clipboard.readText()")
        assert "第 3 局" in text and "大王" not in text and "小王" not in text
        with page.expect_download() as info:
            page.locator("#publicHistorySave").click()
        download = info.value
        target = OUT / f"round-{width}.txt"
        download.save_as(target)
        assert target.read_text(encoding="utf-8") == text.replace("\r\n", "\n"), repr(text)
        page.locator("#publicHistoryRound").select_option("2")
        assert "第 2 局" in page.locator("#publicHistoryTitle").inner_text()
        assert page.locator("#publicHistoryList li").count() == 2
        page.locator("#publicMatchLabel").click()
        assert "最近 1 局" in page.locator("#publicMatchLabel").inner_text()
        assert page.locator("#publicMatchBody tbody tr").count() == 4
        assert "对方 1 局" in page.locator("#publicMatchBody").inner_text()
        assert page.locator("#publicMatchBody img").count() == 0
        with page.expect_download() as info:
            page.locator("#publicMatchSave").click()
        match_file = OUT / f"match-{width}.txt"
        info.value.save_as(match_file)
        match_text = match_file.read_text(encoding="utf-8")
        assert "第 2 局" in match_text and "第 3 局" in match_text
        assert "名次：朋友甲 → 牌友 → 朋友丙 → 朋友乙" in match_text
        assert "大王" not in match_text and "小王" not in match_text
        page.locator("#publicHistoryRound").select_option("")
        assert page.locator("#publicHistoryList li").count() == 4
        rect = page.locator("#publicHistory").bounding_box()
        assert (
            rect["x"] >= 0
            and rect["y"] >= 0
            and rect["x"] + rect["width"] <= width + 1
            and rect["y"] + rect["height"] <= height + 1
        )
        assert not page.evaluate("document.documentElement.scrollWidth>innerWidth")
        page.screenshot(path=str(OUT / f"history-{width}.png"))
        page.keyboard.press("Escape")
        assert not page.locator("#publicHistory").is_visible()
        assert page.evaluate("document.activeElement.id") == "optBtn"
        page.evaluate("G.result={...G.roundHistory[0].result,win:true};G.phase='over';showResult()")
        page.locator("#resultHistoryBtn").click()
        assert page.locator("#publicMatchSummary").get_attribute("open") is not None
        page.keyboard.press("Escape")
        assert page.evaluate("document.activeElement.id") == "resultHistoryBtn"
        assert not errors, errors
        reports.append(
            {
                "width": width,
                "height": height,
                "publicOnly": True,
                "filterAndLiveUpdate": True,
                "downloadMatchesCopy": True,
                "keyboardIsolated": True,
                "pageErrors": errors,
            }
        )
        context.close()
    print(json.dumps(reports))
    browser.close()
