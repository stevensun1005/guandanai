"""Real PeerJS emotes: presets pop up beside the sender's seat on every page, forged ids are dropped,
the per-seat cooldown holds and the mute option hides other players' emotes."""
from pathlib import Path
import json, os, sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file())
URL = next((v for v in sys.argv[1:] if v.startswith('http')), 'http://127.0.0.1:8765/')
OUT = ROOT / 'web/artifacts/validation/emotes'
OUT.mkdir(parents=True, exist_ok=True)
ENDPOINT = json.loads((ROOT / 'web/src/collection/config.json').read_text())['endpoint']


def bubble_seat(page):
    """(local seat, name shown on that seat, bubble text) for the visible bubble beside another seat."""
    return page.evaluate(
        """()=>{for(const n of [1,2,3]){const b=document.querySelector(`.emote-bubble[data-seat="${n}"]`);
        if(b)return [n,document.querySelector(`#seat${n} .name`).textContent.trim(),b.textContent]}return null}"""
    )


with sync_playwright() as p:
    browser = p.chromium.launch(channel=os.environ.get('BROWSER_CHANNEL', 'chrome'), headless=True)
    hc = browser.new_context(viewport={'width': 1440, 'height': 1000})
    gc = browser.new_context(viewport={'width': 390, 'height': 844})
    for context in [hc, gc]:
        context.route(ENDPOINT, lambda route: route.fulfill(status=503, body='isolated test'))
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

    # Host sends the classic phrase; it shows beside the host on both pages.
    host.locator('#emoteBtn').click()
    assert host.locator('#emotePanel').is_visible()
    assert host.locator('#emoteGrid .emote-choice').count() == 16
    assert host.locator('#emotePhrases .emote-choice').count() == 12
    host.locator('#emotePhrases .emote-choice', has_text='给阿姨倒一杯卡布奇诺').click()
    assert host.locator('#emotePanel').is_hidden()
    assert host.locator('.emote-bubble[data-seat="0"]').inner_text() == '给阿姨倒一杯卡布奇诺'
    assert host.locator('#emoteBtn').is_disabled(), 'cooldown blocks immediate repeats'
    guest.wait_for_function('()=>[1,2,3].some(n=>document.querySelector(`.emote-bubble[data-seat="${n}"]`))')
    seat, name, text = bubble_seat(guest)
    assert name == '房主' and text == '给阿姨倒一杯卡布奇诺', (seat, name, text)
    # The bubble sits fully inside the window, next to its name plate.
    for page in [host, guest]:
        assert page.evaluate("""()=>[...document.querySelectorAll('.emote-bubble')].every(b=>{const r=b.getBoundingClientRect();
            return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})""")
    host.wait_for_timeout(400)  # let the pop-in animation finish before capturing
    host.screenshot(path=str(OUT / 'host-sent.png'))
    guest.screenshot(path=str(OUT / 'guest-received.png'))

    # Guest sends an emoji after its own cooldown; it shows beside the guest on the host page.
    guest.locator('#emoteBtn').click()
    assert guest.locator('#emotePanel').is_visible()
    guest.screenshot(path=str(OUT / 'guest-panel.png'))
    guest.locator('#emoteGrid .emote-choice[title=卡布奇诺]').click()
    assert guest.locator('.emote-bubble[data-seat="0"]').inner_text() == '☕'
    host.wait_for_function('()=>[1,2,3].some(n=>document.querySelector(`.emote-bubble[data-seat="${n}"]`)?.textContent==="☕")')
    seat, name, text = bubble_seat(host)
    assert name == '客人' and text == '☕', (seat, name, text)

    # Forged or repeated messages: free text and unknown ids are dropped; the host rate-limits a seat.
    host.wait_for_timeout(3600)
    guest.evaluate("NET.hostConn.send({t:'emote',id:'<img src=x onerror=alert(1)>'})")
    guest.evaluate("NET.hostConn.send({t:'emote',id:'自由文字'})")
    guest.evaluate("NET.hostConn.send({t:'emote',id:'e01'});NET.hostConn.send({t:'emote',id:'e02'})")
    host.wait_for_timeout(800)
    seat, name, text = bubble_seat(host)
    assert text == '😀', 'only the first valid emote inside the cooldown is shown'
    assert host.evaluate("!document.querySelector('.emote-bubble img')")

    # Muting hides other players' emotes but not your own.
    host.wait_for_timeout(3600)
    host.locator('#emoteBtn').click()
    host.locator('#emoteMute').check()
    host.keyboard.press('Escape')
    assert host.locator('#emotePanel').is_hidden()
    guest.evaluate("NET.hostConn.send({t:'emote',id:'e09'})")
    host.wait_for_timeout(800)
    assert bubble_seat(host) is None, 'muted host shows no emotes from others'
    host.wait_for_timeout(2600)
    host.locator('#emoteBtn').click()
    host.locator('#emoteGrid .emote-choice[title=点赞]').click()
    assert host.locator('.emote-bubble[data-seat="0"]').inner_text() == '👍'
    guest.wait_for_function('()=>[1,2,3].some(n=>document.querySelector(`.emote-bubble[data-seat="${n}"]`)?.textContent==="👍")')
    assert not host.evaluate("G.log.some(e=>'emote' in e)"), 'emotes are not game actions'

    print(json.dumps({'kind': 'test', 'realPeerJS': True, 'presets': 28, 'forgedDropped': True,
                      'rateLimited': True, 'muteHidesOthers': True, 'pageErrors': errors}, ensure_ascii=False))
    assert not errors, errors
    browser.close()
