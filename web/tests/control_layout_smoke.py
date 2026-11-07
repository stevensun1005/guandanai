"""Control hit testing over synthetic display states; not completed games or strength evidence."""
from pathlib import Path
import json, os, sys
from playwright.sync_api import sync_playwright
ROOT = next((p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file()))
OUT = ROOT / 'web/artifacts/validation/control-layout'
OUT.mkdir(parents=True, exist_ok=True)
URL = next((v for v in sys.argv[1:] if v.startswith('http')), 'http://127.0.0.1:8765/') + '?test=1'
AUDIT = """
() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect(),
      s = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && !e.closest('[hidden]');
  };
  const buttons = [
    ...document.querySelectorAll('#app button, #coachSuggestions header button, #panel button'),
  ].filter(visible);
  const result = [];
  const stacked = getComputedStyle(document.body).overflowY === 'auto';
  for (const e of buttons) {
    if (stacked) e.scrollIntoView({block: "center", inline: "nearest", behavior: "instant"});
    const r = e.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
      result.push({ id: e.id, issue: 'outside', rect: r.toJSON() });
    for (const other of buttons) {
      if (other === e) break;
      const b = other.getBoundingClientRect();
      if (
        Math.min(r.right, b.right) - Math.max(r.left, b.left) > 2 &&
        Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 2
      )
        result.push({ id: e.id, issue: 'button-overlap', other: other.id });
    }
    const covering = [];
    for (const dx of [0.2, 0.5, 0.8])
      for (const dy of [0.3, 0.7]) {
        const x = r.left + r.width * dx,
          y = r.top + r.height * dy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && !e.contains(hit)) covering.push(hit.id || hit.className);
      }
    if (covering.length)
      result.push({ id: e.id, issue: 'covered', by: [...new Set(covering)] });
  }
  return result;
}
"""
FIXTURE = """
(x) => {
  hideOverlay();
  Object.assign(G, structuredClone(layoutBase));
  G.tok++;
  G.phase = x.phase;
  G.hands[0] = G.hands[0].slice(0, x.n);
  if (x.returning) {
    G.hands[0].push(G.hands[1].shift());
    G.returns = [{ from: 0, to: 1 }];
    G.trib = [{ g: 1, r: 0, tc: G.hands[0].at(-1) }];
  } else {
    G.returns = [];
    G.trib = [];
  }
  G.retPick = {};
  G.tribGivers = [0];
  G.tribPick = {};
  G.shuffler = 0;
  G.cutter = 0;
  G.turn = x.opponentTurn ? 1 : 0;
  G.leader = 0;
  G.paused = true;
  G.clock = x.phase === 'play' ? { who: x.opponentTurn || !x.n ? 1 : 0, left: 15000, total: 15000 } : null;
  G.trick = null;
  G.out = x.n ? [] : [0];
  G.log = [];
  G.ready = x.alreadyReady ? [0] : [];
  G.seen = [];
  G.busy = false;
  G.fresh = [];
  G.fixed =
    x.n > 8
      ? [G.hands[0].slice(0, 3).map((c) => c.id), G.hands[0].slice(3, 6).map((c) => c.id)]
      : [];
  G.myOrder = [];
  if (x.phase === 'play' && x.n === 8) {
    const card = G.hands[1].pop();
    const play = { ...analyze([card], G.L)[0], cards: [card] };
    G.trick = { player: 1, play };
    G.seen = [card];
    G.log = [{ p: 1, ...play, lead: true }];
    G.last = [null, { play }, null, null];
  }
  handView = x.view;
  sel = new Set(x.selected ? G.hands[0].map((c) => c.id) : []);
  render();
  if (x.phase === 'roundEnd' || x.phase === 'over') {
    G.out = x.n ? [1, 3, 2, 0] : [0, 2, 1, 3];
    G.result = { team: x.n ? 1 : 0, up: 3, before: 2, after: 5, aTeam: 0, order: G.out, win: x.phase === "over" };
    G.levels = [5, 2];
    G.lvlTeam = 0;
    showResult();
  }
}
"""
VIEWPORTS = [
    (1920, 1080, False),
    (1440, 900, False),
    (1280, 720, False),
    (1024, 768, False),
    (900, 600, False),
    (899, 600, False),
    (844, 390, False),
    (1280, 500, False),
    (799, 390, False),
    (600, 390, False),
    (700, 500, False),
    (600, 600, False),
    (390, 844, True),
    (844, 390, True),
    (667, 375, True),
    (375, 320, True),
    (375, 450, True),
    (1280, 300, False),
]
STATES = [
    ('shuffle', 0, False, False),
    ('prep', 27, False, False),
    ('prep', 27, False, True),
    ('prep', 27, True, False),
    ('tribPick', 27, False, True),
    ('play', 27, False, True),
    ('play', 27, False, False),
    ('play', 8, False, False),
    ('play', 1, False, True),
    ('play', 0, False, False),
    ('roundEnd', 0, False, False),
    ('roundEnd', 8, False, False),
    ('over', 0, False, False),
]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get('BROWSER_CHANNEL', 'chrome'))
    failures = []
    errors = []
    count = 0
    view_reports = []
    build_versions = set()
    for width, height, mobile in VIEWPORTS:
        if '--targeted' in sys.argv and width not in [1920, 1024, 844, 799, 390, 667, 375] and (width,height)!=(1280,300):
            continue
        for coach in [False, True]:
            context = browser.new_context(viewport={'width': width, 'height': height}, is_mobile=mobile, has_touch=mobile, reduced_motion='reduce')
            context.add_init_script("localStorage.setItem('guandan-coach-v1'," + ('true' if coach else 'false') + ')')
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(URL, wait_until='networkidle')
            build_versions.add(page.locator('meta[name=app-version]').get_attribute('content'))
            page.locator('#nick').fill('布局回归长昵称')
            page.locator('[data-seat=S]').click()
            page.locator('#sitBtn').click()
            for _ in range(300):
                if page.locator('#readyBtn').is_visible():
                    break
                if page.locator('#deckBtn').is_visible() and page.locator('#deckBtn').is_enabled():
                    page.locator('#deckBtn').click()
                page.wait_for_timeout(60)
            page.locator('#readyBtn').wait_for(state='visible')
            page.evaluate('window.layoutBase=structuredClone(G);G.paused=true')
            for phase, n, returning, selected in STATES:
                for view in ['fan', 'flat', 'vert'] if not mobile else ['flat']:
                    case = {'viewport': [width, height], 'mobile': mobile, 'coach': coach, 'phase': phase, 'n': n, 'returning': returning, 'selected': selected, 'view': view}
                    case['alreadyReady'] = phase == 'prep' and selected and not returning
                    case['opponentTurn'] = phase == 'play' and n == 27 and not selected
                    page.evaluate(FIXTURE, case)
                    page.wait_for_timeout(140)
                    issues = page.evaluate(AUDIT)
                    count += 1
                    if issues:
                        failures.append({**case, 'issues': issues})
                        if len(failures) <= 20:
                            page.screenshot(path=str(OUT / f'failure-{len(failures)}.png'))
                    if coach and phase == 'play' and (n == 8) and (view == 'flat'):
                        page.screenshot(path=str(OUT / f'controls-{width}-{height}-{mobile}.png'))
            if (width,height,mobile,coach)==(844,390,False,True):
                case={'phase':'play','n':27,'returning':False,'selected':False,'view':'vert','alreadyReady':False,'opponentTurn':True}
                page.evaluate(FIXTURE,case)
                page.evaluate("""()=>{const deck=makeDeck(),bomb=deck.filter(c=>c.r===9||(c.r===2&&c.s==='H')),
                    ids=new Set(bomb.map(c=>c.id)),rest=deck.filter(c=>!ids.has(c.id));G.L=2;
                    G.hands=[bomb.concat(rest.splice(0,17)),...Array.from({length:3},()=>rest.splice(0,27))];
                    G.fixed=[bomb.map(c=>c.id)];G.myOrder=[];renderHand();
                    if(!analyze(bomb,2).some(s=>s.type==='bomb'&&s.n===10))throw Error('Invalid stress fixture');}""")
                page.wait_for_timeout(200)
                issues=page.evaluate(AUDIT);count+=1
                if issues:failures.append({'viewport':[width,height],'scenario':'legal-ten-card-bomb-vertical','issues':issues})
            print(json.dumps({'viewport': [width, height], 'coach': coach, 'completed': count, 'failures': len(failures)}), flush=True)
            view_reports.append({'viewport': [width, height], 'mobile': mobile, 'coach': coach, 'htmlClasses': page.locator('html').get_attribute('class')})
            context.close()
    report = {'kind': 'synthetic-display-hit-test', 'buildVersions': sorted(build_versions), 'strengthGames': 0, 'trainingUpdates': 0, 'testedStates': count, 'viewports': view_reports, 'failures': failures, 'pageErrors': errors}
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'testedStates': count, 'failures': len(failures), 'examples': failures[:8], 'pageErrors': errors}, ensure_ascii=False))
    browser.close()
    assert not failures
    assert not errors
