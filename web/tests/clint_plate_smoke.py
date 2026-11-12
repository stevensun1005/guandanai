"""Clint plate hints and public celebrations; synthetic UI only, uploads blocked."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file())
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8784/').rstrip('/') + '/?test=1'
OUT = ROOT / 'web/artifacts/validation/clint-sync-20261108-1635'
OUT.mkdir(parents=True, exist_ok=True)
catalog = json.loads((ROOT / 'web/src/ai/model-catalog.json').read_bytes())
guanzero = [m['id'] for m in catalog['models'] if m.get('config', {}).get('history') == 'guanzero-v1'][-1:]
champion = catalog['selection']['danMCaiChampions'][0]
# four-entry menu since 2026-11-09: Clint, newest GuanZero, current champion, danMCai-reason
expected_menu = ['clint-rule', *guanzero, champion, *[b['id'] for b in catalog.get('searchBots', []) if b['base'] == champion][-1:]]
SETUP = """()=>{G.tok++;resetGame();G.round=1;Object.assign(G,{phase:'play',turn:0,L:2,paused:true,pausedBy:0,fixed:[],myOrder:[],reveal:0,gives:[],trib:[],seen:[],log:[],pw:[],out:[],clock:{who:2,left:60000,total:60000}});G.hands=Array.from({length:4},(_,p)=>makeDeck().slice(p*27,p*27+27));G.deck=[];hideOverlay();render();}"""

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    errors, cases = [], []
    for width, height, touch in [(1440, 1000, False), (1280, 720, False), (1024, 768, True), (390, 844, True), (844, 390, True)]:
        context = browser.new_context(viewport={'width': width, 'height': height}, has_touch=touch,
                                      is_mobile=width < 900 and touch, reduced_motion='reduce')
        context.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**', lambda route: route.abort())
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL, wait_until='networkidle')
        page.locator('#nick').fill('布局检查')
        page.locator('[data-seat=S]').click()
        page.locator('#sitBtn').click()
        page.wait_for_function('()=>G!==null')
        page.evaluate(SETUP)
        page.wait_for_timeout(150)
        menu = page.locator('[data-bot-seat=N] option').evaluate_all('(xs)=>xs.map(x=>[x.value,x.textContent])')
        assert [x[0] for x in menu] == expected_menu, menu
        page.evaluate("()=>markActor(2,'洗牌')")
        hint = page.evaluate("""()=>{const a=document.querySelector('#seat2 .who').getBoundingClientRect(),b=document.querySelector('#seat2 .actlbl').getBoundingClientRect();return{plate:a.toJSON(),label:b.toJSON(),phone:isPhone()}}""")
        assert hint['label']['top'] >= hint['plate']['bottom'] + 5, hint
        assert abs((hint['label']['left'] + hint['label']['right'] - hint['plate']['left'] - hint['plate']['right']) / 2) < 2, hint
        celebrations = []
        for seat in [1, 3]:
            page.evaluate("()=>document.querySelectorAll('.fx-tag').forEach(x=>x.remove())")
            page.evaluate('(seat)=>jieFeng(0,seat)', seat)
            d = page.evaluate("""seat=>{const e=document.querySelector('.fx-tag'),r=document.querySelector('#seat'+seat+' .who').getBoundingClientRect();return{seat,x:parseFloat(e.style.left),y:parseFloat(e.style.top),plate:r.toJSON(),phone:isPhone()}}""", seat)
            if d['phone']:
                assert abs(d['x'] - (d['plate']['left'] + d['plate']['right']) / 2) < 1, d
            else:
                assert (d['x'] < d['plate']['left'] if seat == 1 else d['x'] > d['plate']['right']), d
                assert abs(d['y'] - (d['plate']['top'] + d['plate']['bottom']) / 2) < 1, d
            celebrations.append(d)
        grouping = None
        if not page.evaluate('()=>isPhone()'):
            page.evaluate("()=>{G.fixed=[[0,13],[1,14]];render()}")
            page.wait_for_timeout(100)
            grouping = page.evaluate("""()=>{const tag=document.querySelector('#fixTags .fzt').getBoundingClientRect(),card=document.querySelector('#hand [data-id="0"]').getBoundingClientRect();return{tag:tag.toJSON(),card:card.toJSON()}}""")
            assert abs(grouping['card']['top'] - grouping['tag']['top']) <= 4, grouping
        badge = page.evaluate("""()=>{const e=document.querySelector('#myVc');e.className='vc mute';return{display:getComputedStyle(e).display,pseudo:getComputedStyle(e,'::after').content}}""")
        assert badge['display'] == 'none' and badge['pseudo'] in ['none', 'normal', '""'], badge
        assert page.locator('#micBtn').count() == 1
        assert page.evaluate('()=>document.documentElement.scrollWidth<=innerWidth+1')
        page.screenshot(path=str(OUT / f'{width}x{height}.png'))
        cases.append({'viewport': [width, height], 'hint': hint, 'celebrations': celebrations,
                      'grouping': grouping, 'muteBadge': badge, 'menu': menu})
        context.close()
    browser.close()
    assert not errors, errors
    report = {'scope': 'Synthetic UI geometry; no full games, uploads or training', 'cases': cases, 'pageErrors': errors}
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'cases': len(cases), 'pageErrors': errors}))
