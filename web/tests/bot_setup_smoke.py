"""Per-seat models, rotated seating, preference persistence and compact layouts."""

from pathlib import Path
import sys, json
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
OUT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file()) / "web/artifacts/validation/bot-setup"
OUT.mkdir(parents=True, exist_ok=True)
source = json.loads((OUT.parents[3] / 'web/src/ai/model-catalog.json').read_text(encoding='utf8'))
guanzero = [m['id'] for m in source['models'] if m['config'].get('history') == 'guanzero-v1']
champion = source['selection']['danMCaiChampions'][0]
reason = [b['id'] for b in source.get('searchBots', []) if b['base'] == champion][-1:]
# four entries since 2026-11-09: Clint, the newest GuanZero, the current champion, danMCai-reason
expected_choices = ['clint-rule', guanzero[-1], champion, *reason]
retired = ['001', source['selection']['danMCaiChampions'][1], guanzero[-2]]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    reports = []
    for width, height in [(1440, 1000), (390, 844), (844, 390)]:
        page = browser.new_page(
            viewport={"width": width, "height": height},
            is_mobile=width < 900,
            has_touch=width < 900,
        )
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script("localStorage.setItem('guandan-bot-models',JSON.stringify({S:'007',E:'006',N:'004',W:'002'}))")
        # saved choices of entries that left the menu fall back to the default (once, first load)
        page.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem('guandan-bot-choices-v2',JSON.stringify({S:%s,E:%s,N:%s,W:'clint-rule'}))}" % tuple(json.dumps(x) for x in retired))
        page.goto(URL, wait_until="networkidle")
        catalog = page.request.get(URL.rstrip('/') + '/models/catalog.json').json()
        labels = [choice['name'] for choice in catalog['choices']]
        assert [c['id'] for c in catalog['choices']] == expected_choices
        assert catalog['neuralDefaultId'] == source['defaultId'] == source['selection']['danMCaiChampions'][0]
        assert catalog['defaultId'] == source['selection'].get('defaultChoice', source['defaultId'])
        assert [c['name'] for c in catalog['choices']][-1] == 'danMCai-reason-v000855042'
        assert all(page.locator(f'[data-bot-seat={s}]').input_value()==catalog['defaultId'] for s in ['S','E','N'])
        assert page.locator('[data-bot-seat=W]').input_value() == 'clint-rule'
        assert page.evaluate("typeof G") == "undefined"
        assert page.locator('.mode-btn[aria-pressed="true"]').get_attribute("data-mode") == "solo"
        assert page.locator("#lobbyStatus").get_attribute("role") == "status"
        for value in ["0", "1"]:
            page.locator(f'.rule-btn[data-rule="trib"][data-val="{value}"]').click()
            assert (
                page.locator('.rule-btn[data-rule="trib"][aria-pressed="true"]').get_attribute(
                    "data-val"
                )
                == value
            )
        page.locator("#nick").fill("牌友")
        page.locator("#botStyleBox summary").click()
        directions = ["S", "E", "N", "W"]
        for index, direction in enumerate(directions):
            page.locator(f'[data-seat="{direction}"]').click()
            assert (
                page.locator('.seat-btn[aria-pressed="true"]').get_attribute("data-seat")
                == direction
            )
            page.locator("#mixedBotsBtn").click()
            default = page.locator('[data-bot-seat="S"]').input_value()
            expected = {seat: default for seat in directions}
            for seat, model in expected.items():
                select = page.locator(f'[data-bot-seat="{seat}"]')
                assert select.input_value() == model
                assert select.is_disabled() == (seat == direction)
                assert select.locator('option').all_text_contents() == labels
            other = directions[(index + 1) % 4]
            page.locator(f'[data-bot-seat="{other}"]').select_option(champion)
            expected[other] = champion
        assert not page.evaluate("document.documentElement.scrollWidth>innerWidth")
        page.screenshot(path=str(OUT / f"lobby-{width}.png"), full_page=True)
        page.reload(wait_until="networkidle")
        assert page.locator('.seat-btn[aria-pressed="true"]').count() == 0
        for seat, style in expected.items():
            assert page.locator(f'[data-bot-seat="{seat}"]').input_value() == style
        assert not errors, errors
        reports.append(
            {
                "width": width,
                "height": height,
                "seatRotations": 4,
                "modelsPersisted": True,
                "pageErrors": errors,
            }
        )
        page.close()
    print(json.dumps(reports))
    browser.close()
