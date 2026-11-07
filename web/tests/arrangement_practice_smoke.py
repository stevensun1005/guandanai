"""Real public UI: manual grouping, four seats, local records and responsive navigation."""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
OUT = ROOT/'web/artifacts/validation/arrangement-practice'
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8771/'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    page = browser.new_page(viewport={'width':1440,'height':1000}, accept_downloads=True)
    errors, uploads = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: uploads.append(r.url) if r.method=='POST' else None)
    page.goto(URL, wait_until='networkidle')
    page.locator('#practiceBtn').click()
    assert page.locator('#practiceDialog .tm-card').count()==3
    assert page.locator('#practiceEndgame').is_enabled()
    page.screenshot(path=str(OUT/'menu.png'))
    page.locator('#practiceArrange').click()
    panel = page.locator('#arr')
    assert panel.is_visible()
    ids = lambda: page.locator('#arr .mine .card').evaluate_all('(els)=>els.map(e=>+e.dataset.id).sort((a,b)=>a-b)')
    hand = ids()
    assert len(hand)==27 and len(set(hand))==27
    initial = page.locator('#arr .mine .ag').evaluate_all('(els)=>els.map(e=>[...e.querySelectorAll(".card")].map(c=>+c.dataset.id))')
    def pick(id):
        page.locator(f'#arr .mine .card[data-id="{id}"]').click(position={'x':4,'y':14})
    pick(hand[0]); pick(hand[1])
    page.locator('#arr [data-act="group"]').click()
    assert ids()==hand
    pick(hand[0]);page.locator('#arr [data-act="split"]').click()
    assert ids()==hand
    pick(hand[0]);page.locator('#arr [data-act="join"]').last.click()
    assert ids()==hand
    page.locator('#arr [data-act="restore"]').click()
    restored = page.locator('#arr .mine .ag').evaluate_all('(els)=>els.map(e=>[...e.querySelectorAll(".card")].map(c=>+c.dataset.id))')
    assert restored==initial
    card=page.locator('#arr .mine .card').first;card.focus();page.keyboard.press('Enter')
    assert page.locator('#arr .mine .card[aria-pressed="true"]').count()==1
    assert page.locator('#arr .mine .card:focus').count()==1
    page.screenshot(path=str(OUT/'desktop.png'),full_page=True)
    page.locator('#arr [data-act="done"]').click()
    records=lambda: page.evaluate('JSON.parse(localStorage.getItem("guandan-arrange-records"))')
    assert len(records())==1 and records()[0]['assisted'] is True
    page.locator('#arr [data-act="seat"][data-n="0"]').click()
    page.locator('#arr [data-act="done"]').click()
    assert len(records())==1
    for _ in range(3): page.locator('#arr [data-act="done"]').click()
    assert page.locator('#arr .ar-sum').is_visible()
    saved=records(); assert len(saved)==4
    assert len(set(id for r in saved for id in r['hand']))==108
    with page.expect_download() as info: page.locator('#arr [data-act="save"]').click()
    info.value.save_as(str(OUT/'arrangements.txt'))
    text=(OUT/'arrangements.txt').read_text(encoding='utf8')
    exported=json.loads(text.split('#DATA ')[-1].splitlines()[0])
    assert len(exported)==4 and all(r['kind']=='arrangement-practice' for r in exported)
    page.locator('#arrL').select_option('14'); page.locator('#arr [data-act="newdeal"]').click()
    assert page.locator('#arr .ar-info b').nth(1).text_content()=='A'
    # Corrupt old records are skipped, and a failed write remains visible and exportable.
    page.evaluate('''()=>{localStorage.setItem('guandan-arrange-records',JSON.stringify([null,{},...JSON.parse(localStorage.getItem('guandan-arrange-records'))]));window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='guandan-arrange-records')throw Error('quota');return originalSetItem.call(this,k,v)}}''')
    page.locator('#arr [data-act="done"]').click()
    assert page.locator('#arr .ar-storage-warning').is_visible()
    with page.expect_download() as failed_save:
        page.locator('#arr [data-act="save"]').click()
    failed_save.value.save_as(str(OUT/'unsaved-arrangements.txt'))
    assert len(json.loads((OUT/'unsaved-arrangements.txt').read_text(encoding='utf8').split('#DATA ')[-1].splitlines()[0]))==5
    page.evaluate('()=>{Storage.prototype.setItem=originalSetItem}')
    page.locator('#arr [data-act="done"]').click()
    assert page.locator('#arr .ar-storage-warning').count()==0
    for width,height in [(1024,768),(390,844)]:
        page.set_viewport_size({'width':width,'height':height})
        page.wait_for_timeout(200)
        assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
        assert not page.locator('#arr').evaluate('(e)=>e.scrollWidth>e.clientWidth')
        assert page.locator('#arr .mine .card').count()==27
        page.screenshot(path=str(OUT/f'arrange-{width}.png'),full_page=True)
    page.keyboard.press('Escape')
    assert page.locator('#arr').is_hidden() and page.locator('#practiceDialog').is_visible()
    page.screenshot(path=str(OUT/'menu-mobile.png'),full_page=True)
    page.locator('#practiceStart').click()
    for _ in range(250):
        if page.locator('#readyBtn').is_visible(): break
        button=page.locator('#deckBtn')
        if button.is_visible() and button.is_enabled(): button.click()
        page.wait_for_timeout(100)
    page.locator('#readyBtn').wait_for(state='visible')
    assert page.locator('.peek').count()==3
    assert not errors,errors
    assert not uploads,uploads
    report={'publicMenu':True,'physicalCardsPreserved':True,'groupSplitJoinRestore':True,
            'keyboardSelection':True,'fourSeatRecords':True,'exportedRecords':4,'assistedLabels':True,
            'quotaFeedback':True,'quotaExportAvailable':True,'returnToLearnedTable':True,'cloudUploads':0,
            'viewports':[1440,1024,390],'pageErrors':errors}
    (OUT/'report.json').write_bytes((json.dumps(report,indent=2)+'\n').encode())
    print(json.dumps(report));browser.close()
