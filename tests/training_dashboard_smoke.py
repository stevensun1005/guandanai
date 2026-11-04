"""Check the local progress dashboard with the project's existing headless Chrome test stack."""

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

url = os.environ.get("DASHBOARD_URL", "http://127.0.0.1:8766/")
output = Path("work/continuous/dashboard-check")
output.mkdir(parents=True, exist_ok=True)
errors = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1024, "height": 950}, color_scheme="dark")
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.locator("#state[data-phase=running], #state[data-phase=stopped]").wait_for()
    assert page.locator("#matches").inner_text() != "—"
    assert page.locator("#steps").inner_text() != "—"
    assert page.locator("#connection").is_hidden()
    assert "第 1 / 6 步" in page.locator("body").inner_text()
    live = page.request.get(url.rstrip('/') + '/api/status').json()
    if live.get('device', '').startswith('cuda'):
        assert 'GPU 加速' in page.locator('#task').inner_text()
        assert live['learner']['deviceName'] in page.locator('#device').inner_text()
        if (live.get('cpuBaseline') or {}).get('stoppedAt'):
            assert page.locator('#baseline-note').is_visible()
    previous = page.locator("#updated").inner_text()
    page.wait_for_function("previous => document.querySelector('#updated').textContent !== previous", arg=previous)
    page.screenshot(path=str(output / "desktop.png"), full_page=True)
    for scheme in ("dark", "light"):
        page.emulate_media(color_scheme=scheme)
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path=str(output / f"mobile-{scheme}.png"), full_page=True)
    page.route("**/api/status", lambda route: route.abort())
    page.locator("#state[data-phase=unconfirmed]").wait_for()
    assert page.locator("#connection").is_visible()
    assert page.locator("#matches").inner_text() != "—"
    page.unroute("**/api/status")
    page.locator("#state[data-phase=running], #state[data-phase=stopped]").wait_for()
    assert page.locator("#connection").is_hidden()
    assert not errors, errors
    browser.close()
print(json.dumps({"desktop": True, "mobileDarkAndLight": True, "autoRefresh": True, "disconnectRecovery": True, "pageErrors": errors}))
