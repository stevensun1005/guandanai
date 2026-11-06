"""New lobby/table controls, real DOM geometry and presentation-only fixtures."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file())
OUT = ROOT / 'web/artifacts/validation/ui-refresh'
OUT.mkdir(parents=True, exist_ok=True)
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/') + '?test=1'
reports, errors = [], []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    for width, height, mobile in [(1440, 1000, False), (1024, 768, False), (390, 844, True), (844, 390, True)]:
        page = browser.new_page(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL, wait_until='networkidle')
        page.locator('#nick').fill('牌友')
        page.locator('#levelBtn').click()
        assert page.locator('#levelPick [data-lv]').count() == 26
        for level in range(2, 15):
            page.locator(f'[data-level-team=SN][data-lv="{level}"]').click()
            assert page.evaluate('RULES.startLevel') == level
        page.locator('[data-side=EW]').click()
        page.locator('[data-level-team=EW][data-lv="12"]').click()
        box = page.locator('#levelPick').bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= width + 1
        page.screenshot(path=str(OUT / f'lobby-{width}.png'))
        page.keyboard.press('Escape')
        assert page.locator('#levelPick').is_hidden()
        assert page.evaluate('document.activeElement.id') == 'levelBtn'
        page.locator('[data-rule=aFail][data-val=once]').click()
        page.locator('[data-seat=S]').click()
        page.evaluate("""()=>{
          $('#lobby').hidden=true;resetGame();
          const deck=makeDeck();G.hands=[[],[],[],[]];deck.forEach((c,i)=>G.hands[i%4].push(c));
          G.hands[1]=G.hands[1].slice(0,10);
          G.phase='play';G.turn=1;G.round=1;G.log=[];G.seen=[];G.rest=[];G.fixed=[];
          G.myOrder=[];G.pw=[];G.trib=[];G.returns=[];
          G.levels=[14,14];G.aFails=[1,2];G.clock={who:1,left:25000,total:30000};render();
        }""")
        assert page.locator('#lv0').inner_text() == 'A2'
        assert page.locator('#lv1').inner_text() == 'A3'
        page.evaluate('G.aOut=0;render()')
        assert page.locator('#lv1').inner_text() == 'A末'
        page.wait_for_timeout(350)
        page.screenshot(path=str(OUT / f'table-{width}.png'))
        if not mobile:
            clock = page.locator('#seat1 .clock').bounding_box()
            name = page.locator('#seat1 .who').bounding_box()
            status = page.locator('#seat1 .stat').bounding_box()
            count = page.locator('#seat1 .cnt').bounding_box()
            assert clock and name and status and count, page.locator('#seat1').inner_html()
            assert clock['y'] + clock['height'] <= name['y']
            assert name['y'] + name['height'] <= status['y'], [clock,name,status,count]
            assert status['y'] + status['height'] <= count['y'] + 1
        page.screenshot(path=str(OUT / f'table-{width}.png'))
        page.evaluate("""()=>{
          G.phase='prep';G.turn=0;G.clock=null;G.L=2;
          G.hands[0]=makeDeck().filter(c=>c.id<54&&c.s==='S'&&c.r>=3&&c.r<=7);
          G.fixed=[];G.myOrder=[];G.rest=[];sfIdx=0;render();
        }""")
        page.locator('#sfBtn').click()
        assert page.evaluate('sel.size') == 5
        assert '共 1 种同花顺' in page.locator('#msg').inner_text()
        page.locator('#sfBtn').click()
        assert page.evaluate('sel.size') == 0
        assert '已放下' in page.locator('#msg').inner_text()
        page.evaluate("window.tieDone=0;tieGame(()=>window.tieDone++)")
        assert page.locator('.fx-champ.tie').is_visible()
        page.wait_for_timeout(900)
        page.mouse.click(4, 4)
        assert page.evaluate('tieDone') == 1
        assert page.locator('.fx-tie').count() == 0
        reports.append({'viewport': [width,height], 'levelChoices':26, 'aLabels':True, 'flushCycle':True, 'tieSkip':True, 'sideClockGeometry':not mobile})
        page.close()
    browser.close()
assert not errors, errors
(OUT / 'report.json').write_text(json.dumps({'checks':reports,'errors':errors}, indent=2), encoding='utf-8')
print(json.dumps({'checks':reports,'errors':errors}))
