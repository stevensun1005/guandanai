"""Per-seat styles, rotated seating, preference persistence and compact layouts."""
from pathlib import Path
import sys,json
from playwright.sync_api import sync_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/'
OUT=Path(__file__).resolve().parents[1]/'work/validation/bot-setup'
OUT.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    reports=[]
    for width,height in [(1440,1000),(390,844),(844,390)]:
        page=browser.new_page(viewport={'width':width,'height':height},is_mobile=width<900,has_touch=width<900)
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(URL,wait_until='networkidle')
        assert page.evaluate('typeof G')=='undefined'
        page.locator('#nick').fill('牌友')
        page.locator('#botStyleBox summary').click()
        directions=['S','E','N','W']
        for index,direction in enumerate(directions):
            page.locator(f'[data-seat="{direction}"]').click()
            page.locator('#mixedBotsBtn').click()
            expected={directions[(index+step)%4]:style for step,style in enumerate(['balanced','aggressive','observant','conservative'])}
            for seat,style in expected.items():
                select=page.locator(f'[data-bot-seat="{seat}"]')
                assert select.input_value()==style
                assert select.is_disabled()==(seat==direction)
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
        page.screenshot(path=str(OUT/f'lobby-{width}.png'),full_page=True)
        page.reload(wait_until='networkidle')
        for seat,style in expected.items():
            assert page.locator(f'[data-bot-seat="{seat}"]').input_value()==style
        assert not errors,errors
        reports.append({'width':width,'height':height,'seatRotations':4,'stylesPersisted':True,'pageErrors':errors})
        page.close()
    print(json.dumps(reports));browser.close()
