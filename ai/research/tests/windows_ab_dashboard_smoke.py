"""Read-only checks against a live A/B panel; never starts or stops training."""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8766/"
out = next(p for p in Path(__file__).resolve().parents if (p / "package.json").exists()) / "web/artifacts/validation/windows-ab"
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_function("()=>document.querySelectorAll('#arms article').length===2")
    first = page.locator("#updated").text_content()
    page.wait_for_timeout(3500)
    assert page.locator("#updated").text_content() != first
    snapshot = page.request.get(url + "api/status").json()
    assert snapshot["memory"]["reserveGiB"] == 4
    assert not snapshot["webChampionChanged"]
    assert page.request.post(url + "api/status").status == 405
    for width, height in [(1440, 1000), (390, 844)]:
        page.set_viewport_size({"width": width, "height": height})
        assert not page.evaluate("document.documentElement.scrollWidth>innerWidth")
        page.screenshot(path=str(out / f"panel-{width}.png"), full_page=True)
    assert not errors, errors
    report = {"phase": snapshot["phase"], "arms": list(snapshot["arms"]), "liveRefresh": True, "viewports": [1440, 390], "readOnly": True, "pageErrors": errors}
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps(report))
    browser.close()
