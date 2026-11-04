"""Imported results render as text in the list, prior-result banner and replay."""

import json
import os
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
OUT = Path(__file__).resolve().parents[1] / "work/validation/replay-security"
OUT.mkdir(parents=True, exist_ok=True)
payload = '<img src=x onerror="window.injected=true"><svg onload="window.injected=true"></svg>'
record = {
    "no": 1, "L": 2, "uid": "security-original", "nk": "all", "log": [],
    "hands": [list(range(i * 27, (i + 1) * 27)) for i in range(4)],
    "result": payload,
}
source = OUT / "untrusted-record.txt"
source.write_text("#DATA " + json.dumps([record, {**record, "no": 2, "uid": "security-replay", "replayOf": 1}]), encoding="utf-8")
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, channel=os.environ.get("BROWSER_CHANNEL", "chrome"))
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL + "?test=1", wait_until="networkidle")
    page.locator("#practiceBtn").click()
    page.locator("#practiceStart").click()
    page.locator("#tsBtn").click()
    page.locator("#tsLoad").click()
    page.locator("#trecFile").set_input_files(str(source))
    page.wait_for_function("() => (document.querySelector('#trecText').value.includes('#DATA '))")
    page.locator("#trecGo").click()
    assert "导入了 2 局" in page.locator("#trecMsg").inner_text()
    page.evaluate("practiceView(1,0,false)")
    assert page.locator("#tview .tvnote img,#tview .tvnote svg,#tview .tlist img,#tview .tlist svg").count() == 0
    assert payload in page.locator("#tview").inner_text()
    assert "原来：" + payload in page.locator("#tview .tlist").inner_text()
    assert page.evaluate("window.injected!==true")
    assert not errors, errors
    print(json.dumps({"importedResultEscaped": True, "priorResultEscaped": True, "replayResultEscaped": True, "pageErrors": errors}))
    browser.close()
