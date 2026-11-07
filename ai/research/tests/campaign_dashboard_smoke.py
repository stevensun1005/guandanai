"""Read-only validation and fresh captures of the live research campaign panel."""
from pathlib import Path
from datetime import datetime, timezone
import json
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8767/'
out = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file()) / 'web/artifacts/validation/campaign'
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_function("()=>document.querySelector('#updated').textContent.includes('读取时间')")
    first = page.locator('#updated').text_content()
    page.wait_for_timeout(3500)
    assert first != page.locator('#updated').text_content()
    state = page.request.get(url + 'api/status').json()
    assert state['guardianHealthy']
    assert datetime.fromisoformat(state['campaign']['deadlineUTC'].replace('Z','+00:00')) == datetime(2026,11,11,17,tzinfo=timezone.utc)
    assert page.request.post(url + 'api/status').status == 405
    if state['tasks']:
        current = state['tasks'][-1]
        if current['learner'] and current['processAlive'] and not current['state'].get('stoppedAt'):
            assert '训练中' in page.locator('#history tr').first.text_content()
            assert '本次新增' in page.locator('#count').text_content()
    for width, height in [(1440, 1000), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        page.screenshot(path=str(out / f'panel-{width}.png'), full_page=True)
    assert not errors, errors
    report = {'observedAtUTC': state['observedAtUTC'], 'taskCount': len(state['tasks']), 'readOnly': True, 'liveRefresh': True, 'guardianHealthy': True, 'viewports': [1440, 390], 'pageErrors': errors}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report))
    browser.close()
