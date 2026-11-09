"""Move coach on the reasoning bot (danMCai-reason, menu 9001): a solo round with the coach on.
In the search bands the coach's Top 5 comes from the shared search worker (midgame belief-world
rollouts at 21-40 cards, exact 8-world PIMC at <= 20 cards) or says it fell back to the champion;
the coach request carries only the player's own hand and public information; the table bots keep
their own searches (no error panel) while the coach shares their worker."""

from pathlib import Path
import json
import os
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
OUT = ROOT / "web/artifacts/validation/coach-search"
OUT.mkdir(parents=True, exist_ok=True)
PROBE = """const Native=Worker;window.coachSearch={posts:[],replies:[]};
window.Worker=class extends Native{
 constructor(url,...rest){super(url,...rest);this.search=String(url).includes('search-worker');this.coachIds=new Set();
  this.addEventListener('message',e=>{if(this.coachIds.has(e.data.id))window.coachSearch.replies.push(e.data.result||{error:e.data.error});});}
 postMessage(d,...rest){if(this.search&&d.type==='coach'){this.coachIds.add(d.id);window.coachSearch.posts.push(structuredClone(d.payload));}return super.postMessage(d,...rest);}
};"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("BROWSER_CHANNEL", "chrome"))
    errors = []

    def play_round():
        """One solo round with the coach on, in a fresh profile; returns the page and what it saw."""
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        context.add_init_script(PROBE)
        context.route("**/*.workers.dev/**", lambda route: route.abort())
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL + "?test=1", wait_until="networkidle")
        page.locator("#nick").fill("复盘")
        page.locator("#coachStartEnabled").check()
        page.locator('[data-seat="S"]').click()
        page.locator("#sitBtn").click()
        for _ in range(250):
            if page.locator("#readyBtn").is_visible():
                break
            button = page.locator("#deckBtn")
            if button.is_visible() and button.is_enabled():
                button.click()
            page.wait_for_timeout(100)
        page.locator("#readyBtn").click()
        seen = {"midgame": None, "endgame": None}
        turns = []
        for _ in range(3000):
            if page.evaluate("G.phase !== 'play' && G.log.length > 0"):
                break
            assert not page.locator("#retryTableBtn").is_visible()
            state = page.evaluate("({turn:G.turn,phase:G.phase,cards:G.hands.reduce((s,h)=>s+h.length,0),mine:G.hands[0].length})")
            if state["phase"] == "play" and state["turn"] == 0 and page.locator("#hintBtn").is_enabled():
                band = "midgame" if 21 <= state["cards"] <= 40 else "endgame" if state["cards"] <= 20 else None
                if band:
                    # wait for this turn's coach result (search values or the champion fallback)
                    page.wait_for_function(
                        "()=>{const t=document.querySelector('#coachTopStatus').textContent;return !/搜索中|正在比较/.test(t)}",
                        timeout=20000,
                    )
                    status = page.locator("#coachTopStatus").inner_text()
                    header = page.locator("#coachModel").inner_text()
                    rows = page.locator("#coachTop5 .coach-choice-heading").all_inner_texts()
                    turns.append({"band": band, "cards": state["cards"], "status": status, "rows": rows})
                    assert header.startswith("danMCai-reason-v000855042"), header
                    if "推理" in status and seen[band] is None and "未完成" not in status:
                        seen[band] = {"cards": state["cards"], "status": status, "rows": rows}
                        page.screenshot(path=str(OUT / f"{band}.png"))
                    assert page.evaluate("coachAssisted()") is True
                page.locator("#hintBtn").click()
                if page.locator("#playBtn").is_enabled():
                    page.locator("#playBtn").click()
                elif page.locator("#passBtn").is_enabled():
                    page.locator("#passBtn").click()
            page.wait_for_timeout(80)
        probe = page.evaluate("JSON.parse(JSON.stringify(coachSearch))")
        assert page.evaluate("G.phase") in ("roundEnd", "over")
        return page, probe, seen, turns

    # A deal where the player goes out while more than 40 cards remain never reaches a search
    # band; deal again (at most three deals) rather than fail on the shuffle.
    for attempt in range(3):
        page, probe, seen, turns = play_round()
        if probe["posts"]:
            break
        page.context.close()
    stats = page.evaluate("JSON.parse(JSON.stringify(TableBot.searchStats))")
    assert not errors, errors
    assert probe["posts"], "no coach search request in a search band"
    for payload in probe["posts"]:
        assert "hands" not in payload and payload["p"] == 0 and payload["offset"] == 0, payload.keys()
        assert len(payload["hand"]) == payload["counts"][0]
    assert stats["searched"] > 0, stats
    assert any(seen.values()), turns
    report = {
        "deals": attempt + 1,
        "coachRequests": len(probe["posts"]),
        "coachReplies": [
            {k: r.get(k) for k in ("ok", "kind", "fallback", "reason", "evaluated", "used")}
            for r in probe["replies"]
        ],
        "coachStats": stats["coach"],
        "tableSearch": {k: stats[k] for k in ("requests", "searched", "differs", "fallbacks")},
        "seen": seen,
        "turns": turns,
        "pageErrors": errors,
    }
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("deals", "coachRequests", "coachStats", "tableSearch", "seen")}, ensure_ascii=False))
    browser.close()
