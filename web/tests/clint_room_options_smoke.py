"""Room options/layout and automatic-pass boundaries; synthetic state, collector blocked."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file())
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8784/').rstrip('/') + '/?test=1'
OUT = ROOT / 'web/artifacts/validation/clint-sync-20261112'
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    errors, cases = [], []
    for width, height in [(1440, 1000), (1024, 768), (390, 844), (844, 390)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        context.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**', lambda route: route.abort())
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL, wait_until='networkidle')
        page.locator('[data-rule=prepSec][data-val="30"]').click()
        page.locator('[data-rule=playMode][data-val="20+60"]').click()
        page.reload(wait_until='networkidle')
        assert page.evaluate("RULES.prepSec===30 && RULES.playMode==='20+60'")
        assert page.locator('.lobby-photo').get_attribute('role') == 'img'
        widths = page.locator('.mode-btn').evaluate_all('(xs)=>xs.map(x=>x.getBoundingClientRect().width)')
        assert max(widths) - min(widths) < 2, widths
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
        page.screenshot(path=str(OUT / f'lobby-{width}x{height}.png'), full_page=True)
        page.evaluate("setMode('join')")
        assert page.locator('[data-rule=playMode]').evaluate_all('(xs)=>xs.every(x=>x.disabled)')
        page.evaluate("setMode('solo')")
        cases.append({'viewport': [width, height], 'modeWidths': widths, 'savedClockOptions': True})
        context.close()
    context = browser.new_context()
    context.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**', lambda route: route.abort())
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL, wait_until='networkidle')
    # Guest events are captured instead of sent; the short hand with a legal bomb must not pass.
    page.evaluate("""()=>{
      resetGame(); window.sent=[]; NET.mode='guest';NET.off=0;NET.humans=new Set([0]);
      NET.hostConn={open:true,send:e=>sent.push(e)};
      const d=makeDeck(),hand=d.filter(c=>c.r===7).slice(0,4),tr=[...d.slice(0,54).filter(c=>c.s==='C'&&c.r>=9&&c.r<=12),d.find(c=>c.s==='D'&&c.r===13)];
      Object.assign(G,{phase:'play',turn:0,L:2,log:[],seen:[],clock:null,hands:[hand,d.slice(50,60),d.slice(60,70),d.slice(70,80)],trick:{player:1,play:analyze(tr,2).find(x=>x.type==='straight')},paused:false});
      startTurn();G.clock=null;
    }""")
    page.wait_for_timeout(1100)
    assert page.evaluate('sent.length') == 0
    page.evaluate("()=>{G.hands[0]=[makeDeck().find(c=>c.r===3)];startTurn();G.clock=null}")
    page.wait_for_timeout(1100)
    assert page.evaluate("sent.length===1 && sent[0].e.k==='pass' && sent[0].e.automatic===true"), page.evaluate("({sent,turn:G.turn,phase:G.phase,hints:hints.length,TEST,paused:G.paused,trick:G.trick,pending:NET.pending,watching:NET.watching})")
    assert not errors, errors
    report = {'layout': cases, 'bombNotAutoPassed': True, 'forcedPassMarkedAutomatic': True, 'pageErrors': errors, 'strengthGames': 0}
    (OUT / 'room-options.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    browser.close()
