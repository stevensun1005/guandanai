"""Enter the public practice flow, take learned turns, annotate and export."""

import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
OUT = ROOT / "web/artifacts/validation/practice"
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
URL += ("&" if "?" in URL else "?") + "test=1"
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL, wait_until="networkidle")
    page.locator("#practiceBtn").click()
    assert page.locator("#practiceDialog").is_visible()
    page.keyboard.press("Escape")
    assert page.locator("#practiceDialog").is_hidden()
    page.locator("#practiceBtn").click()
    page.locator("#practiceStart").click()
    page.wait_for_function('() => (TEST===true)')
    for _ in range(250):
        if page.locator("#readyBtn").is_visible():
            break
        button = page.locator("#deckBtn")
        if button.is_visible() and button.is_enabled():
            button.click()
        page.wait_for_timeout(100)
    page.locator("#readyBtn").wait_for(state="visible")
    assert page.locator(".peek").count() == 3
    page.locator("#readyBtn").click()
    for _ in range(300):
        if page.evaluate("G.log.length>=6"):
            break
        if page.evaluate("G.turn===0"):
            page.locator("#hintBtn").click()
            if page.locator("#playBtn").is_enabled():
                page.locator("#playBtn").click()
            elif page.locator("#passBtn").is_enabled():
                page.locator("#passBtn").click()
        elif page.locator("#goBtn").is_visible():
            page.locator("#goBtn").click()
        page.wait_for_timeout(100)
    assert page.evaluate("G.log.length>=6")
    page.wait_for_function("() => !document.querySelector('#undoBtn').disabled")
    before_undo = page.evaluate('G.log.length')
    page.locator('#undoBtn').click()
    page.wait_for_function('n => G.log.length===n-1', arg=before_undo)
    page.locator("#tsBtn").click()
    page.locator("#tsList .tedit").first.click()
    page.locator("#tnText").fill("保留对子，观察下一家的回应。<b>这是文字</b>")
    page.locator("#tnOk").click()
    assert "保留对子" in page.locator("#tsList").inner_text()
    assert page.locator("#tsList .tnote b").count() == 0
    with page.expect_download() as download_info:
        page.locator("#tsSave").click()
    download = download_info.value
    download.save_as(str(OUT / "practice-record.txt"))
    text = (OUT / "practice-record.txt").read_text(encoding="utf-8-sig")
    data = json.loads(text.split("#DATA ")[-1].splitlines()[0])
    assert data[0]["log"]
    assert text.startswith("GuandanAI 复盘记录")
    page.screenshot(path=str(OUT / "practice-desktop.png"))
    page.wait_for_function("() => (localStorage.getItem('guandan-practice-records')?.includes('保留对子'))")
    # A fresh browser imports the exported annotated record and refuses a damaged one.
    imported = browser.new_page(viewport={"width": 1440, "height": 1000})
    imported.on("pageerror", lambda error: errors.append(str(error)))
    imported.goto(URL, wait_until="networkidle")
    imported.locator("#practiceBtn").click()
    imported.locator("#practiceStart").click()
    imported.locator("#tsBtn").click()
    imported.locator("#tsLoad").click()
    imported.locator("#trecFile").set_input_files(str(OUT / "practice-record.txt"))
    imported.wait_for_function("() => (document.querySelector('#trecText').value.includes('#DATA '))")
    imported.locator("#trecGo").click()
    assert "导入了 1 局" in imported.locator("#trecMsg").inner_text()
    assert imported.evaluate("TREC.rounds.length") == 1
    imported.locator("#trecText").fill("#DATA " + json.dumps([None, {"L": 99}]))
    imported.locator("#trecGo").click()
    assert "跳过 2 局损坏记录" in imported.locator("#trecMsg").inner_text()
    assert imported.evaluate("TREC.rounds.length") == 1
    imported.locator("#trecClose").click()
    imported.evaluate("""()=>{window.originalSetItem=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key==='guandan-practice-records')throw Error('quota');return originalSetItem.call(this,key,value)};practiceStore()}""")
    imported.locator("#practiceStorageNotice").wait_for(state="visible")
    imported.evaluate("Storage.prototype.setItem=originalSetItem;practiceStore()")
    imported.locator("#practiceStorageNotice").wait_for(state="hidden")
    # The old local key is still understood and migrates on the next successful save.
    legacy = browser.new_page()
    legacy.add_init_script(
        'localStorage.setItem("guandan-test-records",' + json.dumps(json.dumps(data)) + ")"
    )
    legacy.on("pageerror", lambda error: errors.append(str(error)))
    legacy.goto(URL, wait_until="networkidle")
    legacy.locator("#practiceBtn").click()
    legacy.locator("#practiceStart").click()
    assert legacy.evaluate("TREC.rounds.length") == 1
    legacy.evaluate("practiceStore()")
    legacy.wait_for_function(
        "() => (localStorage.getItem('guandan-practice-records')!==null&&localStorage.getItem('guandan-test-records')===null)"
    )
    assert not errors, errors
    print(
        json.dumps(
            {
                "publicPracticeEntry": True,
                "learnedTurns": page.evaluate("G.log.length"),
                "annotatedExport": True,
                "freshBrowserImport": True,
                "corruptRecordsSkipped": True,
                "quotaFeedback": True,
                "legacyMigration": True,
                "pageErrors": errors,
            }
        )
    )
    browser.close()
