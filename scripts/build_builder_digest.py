#!/usr/bin/env python3
"""Daily AI-builder digest.

Two things in one LLM call:
  1. an overview of today's AI product news (new agents / features) + builder sentiment
  2. a one-sentence Chinese summary for every post, so the feed is skimmable

Output: data/builder-digest.json  (read by the app)

Reuses the LLM plumbing (call_llm / extract_json) from build_digest.py.
Provider defaults to DeepSeek; override with LLM_BASE_URL / LLM_MODEL / LLM_API_KEY.
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_digest as bd  # noqa: E402  (call_llm / extract_json / DEFAULT_*)

DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(DATA, "builder-digest.json")
FEED = "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/"
UA = {"User-Agent": "research-radar/1.0"}
MAX_POSTS = 40          # newest N posts fed to the model
MAX_CHARS = 900         # per-post text cap

SYSTEM = (
    "你是 AI 行业编辑，为中文读者写每日 AI 动态。"
    "你只依据给出的原文写作，绝不编造产品名、功能或数字。"
)

PROMPT = """下面是今天 AI builder 们在 X、博客和播客上的最新动态，共 {n} 条。

请做两件事。

【一】写一段**今日 AI 动态总览**，用大白话，面向关心 AI 产品的人：
- headline：一句话概括今天最值得知道的事（不超过 40 字）
- bullets：3–5 条要点，每条一句话。重点抓：
  · 新发布的 agent / 模型 / 产品
  · 新功能、新能力（能做什么以前做不到的事）
  · 重要的价格、政策、开源动作
  · builder 们反复在讨论的同一件事
- sentiment：一句话说 builder 们整体什么情绪（兴奋 / 焦虑 / 吐槽 / 观望……），并说清是对什么

【二】为**每一条**动态写一句话中文总结（summaryZh），让人不用读英文就知道作者想说什么：
- 抓住作者的核心观点或结论，不要逐字翻译
- 如果是产品发布，说清「谁发布了什么、有什么用」
- 如果是观点/吐槽，说清「他认为什么、为什么」
- 不超过 60 字

硬性约束：
1. 只能使用原文中写出的信息。**不得编造产品名、功能、版本号或数字。**
2. 原文没提到的东西不要写。
3. 中文撰写；产品名、模型名、公司名保留英文原文（如 Claude Code、GPT-5、Cursor）。
4. 口语化，短句，不要官腔。

只输出 JSON，不要 markdown 代码块，不要任何解释文字：
{{
  "headline": "…",
  "bullets": ["…", "…", "…"],
  "sentiment": "…",
  "posts": [
    {{"id": "…", "summaryZh": "…"}}
  ]
}}

===== 动态列表 =====
{posts}
"""


def get(url, timeout=45):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def collect(limit=MAX_POSTS):
    """Flatten the three feeds into one newest-first list."""
    out = []
    try:
        x = get(FEED + "feed-x.json")
        for b in x.get("x", []):
            for t in b.get("tweets", []):
                txt = (t.get("text") or "").strip()
                if not txt:
                    continue
                out.append({
                    "id": t.get("url") or "",
                    "type": "x",
                    "kind": "X 动态",
                    "name": b.get("name") or b.get("handle") or "",
                    "handle": b.get("handle") or "",
                    "text": txt,
                    "date": t.get("createdAt") or "",
                })
    except Exception as e:  # noqa: BLE001
        print("  ! feed-x failed:", e, file=sys.stderr)

    for feed, key, typ, kind in (("feed-blogs.json", "blogs", "blog", "官方博客"),
                                 ("feed-podcasts.json", "podcasts", "podcast", "播客")):
        try:
            d = get(FEED + feed)
        except Exception as e:  # noqa: BLE001
            print("  ! %s failed: %s" % (feed, e), file=sys.stderr)
            continue
        for b in d.get(key, []):
            txt = (b.get("description") or b.get("summary") or b.get("content") or "").strip()
            title = (b.get("title") or "").strip()
            if not (txt or title):
                continue
            out.append({
                "id": b.get("url") or (title + "|" + (b.get("name") or "")),
                "type": typ, "kind": kind,
                "name": b.get("name") or b.get("show") or "",
                "handle": "",
                "title": title,
                "text": txt,
                "date": b.get("publishedAt") or b.get("date") or "",
            })

    out.sort(key=lambda o: o.get("date") or "", reverse=True)
    return out[:limit]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=MAX_POSTS)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    key = os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or ""
    base = os.environ.get("LLM_BASE_URL") or bd.DEFAULT_BASE
    model = os.environ.get("LLM_MODEL") or bd.DEFAULT_MODEL

    print("[1/3] collecting builder posts ...")
    posts = collect(a.n)
    print("      %d posts" % len(posts))
    if not posts:
        print("no posts — nothing to do")
        return 0

    blocks = []
    for i, p in enumerate(posts, 1):
        body = " ".join((p.get("text") or "").split())[:MAX_CHARS]
        head = p.get("title") or ""
        who = ("@" + p["handle"]) if p.get("handle") else p.get("name", "")
        blocks.append("[%d] id=%s | %s | %s | %s\n%s%s\n" % (
            i, p["id"], p["kind"], who, p.get("date", ""),
            (head + "\n") if head else "", body))
    prompt = PROMPT.format(n=len(posts), posts="\n".join(blocks))
    print("[2/3] prompt: %d chars (~%d tokens)" % (len(prompt), len(prompt) // 2))

    if a.dry_run:
        print("\n--- PROMPT (first 1200) ---\n" + prompt[:1200])
        print("\n(dry run: model not called)")
        return 0

    if not key:
        print("ERROR: no API key. Set LLM_API_KEY (or DEEPSEEK_API_KEY).", file=sys.stderr)
        return 2

    print("[3/3] calling %s ..." % model)
    parsed = bd.extract_json(bd.call_llm(base, key, model, prompt))

    by_id = {str(x.get("id", "")): (x.get("summaryZh") or "").strip()
             for x in parsed.get("posts", []) if x.get("id")}
    n_zh = 0
    for p in posts:
        p["summaryZh"] = by_id.get(p["id"], "")
        if p["summaryZh"]:
            n_zh += 1

    digest = {
        "date": date.today().isoformat(),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": model,
        "headline": (parsed.get("headline") or "").strip(),
        "bullets": [b.strip() for b in (parsed.get("bullets") or []) if b and b.strip()],
        "sentiment": (parsed.get("sentiment") or "").strip(),
        "count": len(posts),
        "summarised": n_zh,
        "posts": posts,
    }
    json.dump(digest, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print("      wrote %s" % os.path.relpath(OUT, HERE))
    print("      headline : %s" % digest["headline"][:70])
    for b in digest["bullets"]:
        print("      • %s" % b[:70])
    print("      sentiment: %s" % digest["sentiment"][:70])
    print("      summarised %d / %d posts" % (n_zh, len(posts)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
