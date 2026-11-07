"""Real PeerJS emotes: gifts fly between seats on every page, computer seats answer gifts from
people, quick phrases pop up and are spoken, forged ids or receivers are dropped, the per-seat
cooldown holds and the mute option hides other players' emotes."""
from pathlib import Path
import json, os, sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file())
URL = next((v for v in sys.argv[1:] if v.startswith('http')), 'http://127.0.0.1:8765/')
OUT = ROOT / 'web/artifacts/validation/emotes'
OUT.mkdir(parents=True, exist_ok=True)
ENDPOINT = json.loads((ROOT / 'web/src/collection/config.json').read_text())['endpoint']
# Record what speech synthesis is asked to say instead of making noise.
SPEECH_STUB = """window.__spoken=[];if(window.speechSynthesis){speechSynthesis.speak=(u)=>__spoken.push([u.text,u.lang,u.pitch]);}"""


def name_of(page, local):
    return page.evaluate(f"document.querySelector('#seat{local} .name').textContent.trim()")


def seat_named(page, name):
    return next(n for n in [1, 2, 3] if name_of(page, n) == name)


def wait_gift(page, frm, to, timeout=6000):
    page.wait_for_function(
        f"()=>!!document.querySelector('.emote-gift[data-from=\"{frm}\"][data-to=\"{to}\"]')", timeout=timeout)
    return page.evaluate(f"document.querySelector('.emote-gift[data-from=\"{frm}\"][data-to=\"{to}\"]').textContent")


def bot_answer(page, bot, timeout=6000):
    """The bot's reply as seen on this page: a gift aimed somewhere, or its own emoji bubble."""
    page.wait_for_function(
        f"""()=>!!document.querySelector('.emote-gift[data-from="{bot}"], .emote-bubble[data-seat="{bot}"]')""",
        timeout=timeout)
    return page.evaluate(f"""()=>{{const g=document.querySelector('.emote-gift[data-from="{bot}"]');
        if(g)return ['gift',g.textContent,+g.dataset.to];
        const b=document.querySelector('.emote-bubble[data-seat="{bot}"]');return ['emoji',b.textContent,null]}}""")


def open_tab(page, tab):
    if page.locator('#emotePanel').is_hidden():
        page.locator('#emoteBtn').click()
    page.locator(f'#emoteTabs [data-tab={tab}]').click()


def send_gift(page, gift_id, local):
    open_tab(page, 'emotes')
    page.locator(f'#emoteGrid .emote-choice[data-id={gift_id}]').click()
    assert page.locator('#emoteTargets').is_visible()
    page.locator(f'#emoteTargets .emote-target[data-to="{local}"]').click()
    assert page.locator('#emotePanel').is_hidden()


with sync_playwright() as p:
    browser = p.chromium.launch(channel=os.environ.get('BROWSER_CHANNEL', 'chrome'), headless=True)
    hc = browser.new_context(viewport={'width': 1440, 'height': 1000})
    gc = browser.new_context(viewport={'width': 390, 'height': 844})
    for context in [hc, gc]:
        context.route(ENDPOINT, lambda route: route.fulfill(status=503, body='isolated test'))
        context.add_init_script(SPEECH_STUB)
    host, guest = hc.new_page(), gc.new_page()
    errors = []
    for page in [host, guest]:
        page.on('pageerror', lambda e: errors.append(str(e)))

    host.goto(URL + '?test=1', wait_until='networkidle')
    host.locator('#nick').fill('房主')
    host.locator('[data-mode=host]').click()
    host.wait_for_function('()=>NET.peerOpen', timeout=30000)
    host.locator('[data-seat=S]').click()
    code = host.locator('#roomCodeShow').inner_text()
    guest.goto(URL + '?test=1&room=' + code, wait_until='networkidle')
    guest.locator('#nick').fill('客人')
    guest.locator('#joinBtn').click()
    guest.wait_for_function('()=>NET.hostConn?.open', timeout=30000)
    guest.locator('[data-seat=E]').click()
    host.wait_for_function("()=>NET.lobby.E==='客人'")
    host.locator('#sitBtn').click()
    for page in [host, guest]:
        page.wait_for_function('()=>!!G && !document.querySelector("#emoteBtn").closest("[hidden]")', timeout=30000)
    host.wait_for_timeout(500)
    guest_on_host, host_on_guest = seat_named(host, '客人'), seat_named(guest, '房主')
    bots_on_host = [n for n in [1, 2, 3] if n != guest_on_host]
    # Computer seats are labelled relative to each viewer, so map seats through absolute numbers.
    host_off, guest_off = host.evaluate('NET.off'), guest.evaluate('NET.off')
    on_guest = lambda host_local: (host_local + host_off - guest_off) % 4
    assert on_guest(guest_on_host) == 0 and on_guest(0) == host_on_guest

    # The panel keeps exactly the five emotes (three gifts) and the twelve phrases.
    host.locator('#emoteBtn').click()
    assert host.locator('#emotePanel').is_visible()
    labels = host.locator('#emoteGrid .emote-choice .emote-label').all_inner_texts()
    assert labels == ['卡布奇诺', '鲜花', '炸弹', '墨镜', '哭'], labels
    # The round button sits at the bottom right, just right of 理牌; the panel opens above it, in the window.
    for page in [host, guest]:
        if page is guest:
            page.locator('#emoteBtn').click()
        if page.locator('#sortBtn').is_visible():
            assert page.evaluate("""()=>{const e=document.querySelector('.handtools #emoteBtn').getBoundingClientRect(),
                s=document.querySelector('#sortBtn').getBoundingClientRect();
                return e.left>=s.right-1&&Math.abs((e.top+e.bottom)/2-(s.top+s.bottom)/2)<8&&e.right<=innerWidth}"""), 'right of 理牌'
        else:
            # Empty hands hide sorting controls; the social action remains visible and clickable.
            assert page.evaluate("""()=>{const e=document.querySelector('#emoteBtn'),b=e.getBoundingClientRect();
                return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&
                  e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))}""")
        assert page.evaluate("""()=>{const b=document.querySelector('#emoteBtn').getBoundingClientRect(),
            p=document.querySelector('#emotePanel').getBoundingClientRect();
            return p.bottom<=b.top+1&&p.left>=0&&p.right<=innerWidth&&p.top>=0}"""), 'panel above the button'
    guest.wait_for_timeout(300)  # let the pop-in finish before capturing
    guest.screenshot(path=str(OUT / 'guest-panel.png'))
    guest.keyboard.press('Escape')
    host.screenshot(path=str(OUT / 'host-panel.png'))
    assert host.locator('#emotePhrases').is_hidden(), 'phrases sit on their own tab'
    host.locator('#emoteTabs [data-tab=phrases]').click()
    phrases = host.locator('#emotePhrases .emote-choice').all_inner_texts()
    host.screenshot(path=str(OUT / 'host-phrases.png'))
    assert len(phrases) == 8 and not any(w in t for t in phrases for w in ['炸', '留着', '靠你', '稳住']), phrases

    # A quick phrase pops up beside the host on both pages and is read aloud on both.
    host.locator('#emotePhrases .emote-choice', has_text='给阿姨倒一杯卡布奇诺').click()
    assert host.locator('#emotePanel').is_hidden()
    assert host.locator('.emote-bubble[data-seat="0"]').inner_text() == '给阿姨倒一杯卡布奇诺'
    assert host.locator('#emoteBtn').is_disabled(), 'cooldown blocks immediate repeats'
    guest.wait_for_function(f'()=>document.querySelector(\'.emote-bubble[data-seat="{host_on_guest}"]\')')
    assert guest.locator(f'.emote-bubble[data-seat="{host_on_guest}"]').inner_text() == '给阿姨倒一杯卡布奇诺'
    spoken_host, spoken_guest = host.evaluate('__spoken'), guest.evaluate('__spoken')
    assert spoken_host and spoken_host[-1][:2] == ['给阿姨倒一杯卡布奇诺', 'zh-CN'], spoken_host
    assert spoken_guest and spoken_guest[-1][0] == '给阿姨倒一杯卡布奇诺', spoken_guest
    assert spoken_host[-1][2] != spoken_guest[-1][2], 'each seat has its own voice pitch'
    for page in [host, guest]:
        assert page.evaluate("""()=>[...document.querySelectorAll('.emote-bubble')].every(b=>{const r=b.getBoundingClientRect();
            return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})""")

    # The guest throws a flower at the host: the chooser lists the three other seats by name.
    open_tab(guest, 'emotes')
    guest.locator('#emoteGrid .emote-choice[data-id=g02]').click()
    targets = guest.locator('#emoteTargets .emote-target').all_inner_texts()
    assert len(targets) == 3 and any('房主' in t for t in targets), targets
    guest.wait_for_timeout(250)
    guest.screenshot(path=str(OUT / 'guest-targets.png'))
    guest.locator(f'#emoteTargets .emote-target[data-to="{host_on_guest}"]').click()
    assert guest.locator('.emote-flight').count() == 1, 'the gift flies before it lands'
    assert wait_gift(guest, 0, host_on_guest) == '🌹'
    assert wait_gift(host, guest_on_host, 0) == '🌹'
    host.wait_for_timeout(300)
    host.screenshot(path=str(OUT / 'host-got-flower.png'))
    assert host.evaluate("!G.log.some(e=>'emote' in e || e.k==='emote')"), 'emotes are not game actions'

    # The host bombs a computer seat; the computer answers within two seconds, on both pages.
    host.wait_for_timeout(2700)
    bomb_bot = bots_on_host[0]
    send_gift(host, 'g03', bomb_bot)
    assert wait_gift(host, 0, bomb_bot) == '💣'
    host.wait_for_timeout(150)
    host.screenshot(path=str(OUT / 'host-bomb.png'))
    kind, text, aimed = bot_answer(host, bomb_bot)
    assert (kind, text, aimed) in [('gift', '💣', 0), ('emoji', '😭', None)], (kind, text, aimed)
    bot_on_guest = on_guest(bomb_bot)
    g_kind, g_text, g_aimed = bot_answer(guest, bot_on_guest)
    assert (g_kind, g_text) == (kind, text) and (g_aimed is None or g_aimed == host_on_guest)
    host.screenshot(path=str(OUT / 'host-bot-answer.png'))

    # The guest gives a cappuccino to the other computer; the host decides its answer to the guest.
    guest.wait_for_timeout(500)
    cup_bot = bots_on_host[1]
    cup_bot_on_guest = on_guest(cup_bot)
    send_gift(guest, 'g01', cup_bot_on_guest)
    kind, text, aimed = bot_answer(guest, cup_bot_on_guest)
    assert (kind, text, aimed) in [('gift', '☕', 0), ('emoji', '😎', None)], (kind, text, aimed)

    # Forged or repeated messages: unknown ids, gifts without a fair receiver, receivers on
    # non-gifts are dropped; the host rate-limits a seat.
    host.wait_for_timeout(3000)
    for page in [host, guest]:
        page.evaluate("document.querySelectorAll('.emote-bubble,.emote-gift').forEach(n=>n.remove())")
    guest_abs = guest_off
    guest.evaluate("NET.hostConn.send({t:'emote',id:'<img src=x onerror=alert(1)>'})")
    guest.evaluate("NET.hostConn.send({t:'emote',id:'自由文字'})")
    guest.evaluate("NET.hostConn.send({t:'emote',id:'g01'})")
    guest.evaluate(f"NET.hostConn.send({{t:'emote',id:'g03',to:{guest_abs}}})")
    guest.evaluate("NET.hostConn.send({t:'emote',id:'g03',to:9})")
    guest.evaluate("NET.hostConn.send({t:'emote',id:'e01',to:0})")
    host.wait_for_timeout(600)
    assert host.evaluate("!document.querySelector('.emote-bubble,.emote-gift,.emote-flight')"), 'all forged dropped'
    guest.evaluate("NET.hostConn.send({t:'emote',id:'e01'});NET.hostConn.send({t:'emote',id:'e02'})")
    host.wait_for_timeout(800)
    assert host.locator(f'.emote-bubble[data-seat="{guest_on_host}"]').inner_text() == '😎', \
        'only the first valid emote inside the cooldown is shown'
    assert host.evaluate("!document.querySelector('.emote-bubble img')")

    # Muting hides other players' emotes and gifts but not your own.
    host.wait_for_timeout(3600)
    host.locator('#emoteBtn').click()
    host.locator('.emote-mute').click()
    assert host.locator('#emoteMute').is_checked()
    host.keyboard.press('Escape')
    assert host.locator('#emotePanel').is_hidden()
    guest.evaluate("NET.hostConn.send({t:'emote',id:'e02'})")
    host.wait_for_timeout(800)
    assert host.evaluate("!document.querySelector('.emote-bubble:not([data-seat=\"0\"])')"), 'muted: no bubbles'
    host.wait_for_timeout(2600)
    guest.evaluate("NET.hostConn.send({t:'emote',id:'g02',to:0})")
    host.wait_for_timeout(1200)
    assert host.evaluate("!document.querySelector('.emote-gift:not([data-from=\"0\"]),.emote-flight')"), 'muted: no gifts'
    open_tab(host, 'emotes')
    host.locator('#emoteGrid .emote-choice[data-id=e01]').click()
    assert host.locator('.emote-bubble[data-seat="0"]').inner_text() == '😎'
    guest.wait_for_function(f'()=>document.querySelector(\'.emote-bubble[data-seat="{host_on_guest}"]\')?.textContent==="😎"')

    print(json.dumps({'kind': 'test', 'realPeerJS': True, 'emotes': 5, 'phrases': 8, 'buttonRightOfSort': True, 'giftsFly': True,
                      'botAnswers': True, 'phrasesSpoken': True, 'forgedDropped': True,
                      'rateLimited': True, 'muteHidesOthers': True, 'pageErrors': errors}, ensure_ascii=False))
    assert not errors, errors
    browser.close()
