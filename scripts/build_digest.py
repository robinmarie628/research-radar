#!/usr/bin/env python3
"""Generate 通俗版五段摘要 for the daily shortlist via an OpenAI-compatible LLM.

Fields: 背景 / 创新点 / 怎么做的 / 看点·临床含义 / 未来研究方向

Reuses build_snapshot.py for the Europe PMC fetch + 今日精选 curation, so the
digest always matches what the page shows.

Output  data/digest.json   — read by the app; fields keyed by DOI
        data/pushed.txt    — DOIs already covered, so days don't repeat

Provider defaults to DeepSeek but any OpenAI-compatible endpoint works:
    LLM_BASE_URL   (default https://api.deepseek.com)
    LLM_MODEL      (default deepseek-chat)
    LLM_API_KEY / DEEPSEEK_API_KEY

stdlib only.  Usage:  python build_digest.py [--n 5] [--dry-run]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_snapshot as bs  # noqa: E402  (sibling module: fetch + curate)

DATA = os.path.join(HERE, "..", "data")
DIGEST = os.path.join(DATA, "digest.json")
PUSHED = os.path.join(DATA, "pushed.txt")

DEFAULT_BASE = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"
MAX_ABSTRACT = 2600          # chars per paper fed to the model
PUSHED_KEEP = 400            # remember this many DOIs

# field order used when writing digest.json (and rendered in this order by the page)
FIELDS = ["background", "innovation", "methods", "takeaway", "future"]
FIELD_ZH = {"background": "背景", "innovation": "创新", "methods": "做法",
            "takeaway": "看点", "future": "未来"}

SYSTEM = (
    "你是临床医学编辑，为医生撰写每日顶刊速递。"
    "你的读者是临床医生和医学生，不是本领域的专家。"
    "你只依据给出的摘要原文写作，绝不推测或编造任何信息。"
)

PROMPT = """下面是从顶刊筛选出的 {n} 篇论文，每篇附标题、期刊、研究类型与摘要原文。

请用**通俗语言**为每一篇写五个字段（读得懂、看得快）：

- background（背景）：这个领域现在面临什么问题？为什么值得做这项研究？2–3 句。
- innovation（创新点）：这篇新在哪里——新机制 / 新人群 / 新终点 / 首个……？1–2 句。
- methods（怎么做的）：研究设计、研究对象、样本量、主要终点是什么？2–3 句，用大白话讲清楚。
- takeaway（看点 / 临床含义）：关键结果数字是什么？对临床决策意味着什么？2–3 句。
- future（未来研究方向）：还有哪些问题没解决？下一步该验证什么？1–2 句。

再从这 {n} 篇中选出 1 篇作为「今日首选」，给出 1 句理由（选证据等级最高、临床影响最大的一篇）。

写作要求：
1. **通俗**：像给非本专业的同事讲解。句子短，避免堆砌术语，不要照抄英文句式。
2. 必须出现的专业名词保留英文原词（hazard ratio、intention-to-treat、non-inferiority 等），必要时用一句话解释。
3. **只能使用摘要中明确写出的信息**。不得推测、不得编造、不得引入摘要之外的知识。
4. 数字必须与摘要完全一致；不得把亚组结果说成主要终点。
5. 若摘要确实没有某个字段的内容，该字段写「摘要未提及」。
6. 每个字段不超过 120 字。

只输出 JSON，不要 markdown 代码块，不要任何解释文字：
{{
  "items": [
    {{"index": 1, "background": "…", "innovation": "…", "methods": "…", "takeaway": "…", "future": "…"}}
  ],
  "topPick": {{"index": 2, "reason": "…"}}
}}

===== 论文列表 =====
{papers}
"""


def load_pushed():
    if not os.path.exists(PUSHED):
        return []
    with open(PUSHED, encoding="utf-8") as f:
        return [l.strip().lower() for l in f if l.strip()]


def save_pushed(dois):
    keep = dois[-PUSHED_KEEP:]
    with open(PUSHED, "w", encoding="utf-8") as f:
        f.write("\n".join(keep) + ("\n" if keep else ""))


def paper_block(i, a):
    body = a.get("abstract") or ""
    sec = a.get("sections") or {}
    if not body and sec:
        body = " ".join(f"{k}: {v}" for k, v in sec.items() if v)
    body = " ".join(body.split())[:MAX_ABSTRACT]
    kind = "基础/分子医学" if a.get("basic") else "临床"
    return (
        f"[{i}] 期刊：{a.get('journal')}｜领域：{a.get('domain')}｜"
        f"研究类型：{a.get('studyZh')}｜{kind}｜{a.get('date')}\n"
        f"标题：{a.get('title')}\n"
        f"摘要：{body}\n"
    )


def call_llm(base, key, model, prompt, tries=3, timeout=180):
    url = base.rstrip("/") + "/chat/completions"
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")

    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=payload, headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + key,
                "User-Agent": "research-radar/1.0",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            last = f"HTTP {e.code}: {detail}"
            if e.code in (401, 402, 403):     # bad key / no balance — don't retry
                break
        except Exception as e:  # noqa: BLE001
            last = str(e)
        if attempt < tries - 1:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"LLM call failed: {last}")


def extract_json(text):
    """Models sometimes wrap JSON in prose or fences — dig it out."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:  # noqa: BLE001
        m = re.search(r"\{[\s\S]*\}", t)
        if not m:
            raise
        return json.loads(m.group(0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=8, help="papers per day")
    ap.add_argument("--days", type=int, default=30, help="Europe PMC window")
    ap.add_argument("--dry-run", action="store_true",
                    help="build the prompt and print it, but do not call the model")
    a = ap.parse_args()

    key = os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or ""
    base = os.environ.get("LLM_BASE_URL") or DEFAULT_BASE
    model = os.environ.get("LLM_MODEL") or DEFAULT_MODEL

    print(f"[1/4] fetching candidates (last {a.days}d) ...")
    jr = bs.build_journals(a.days)
    items = jr["items"]
    print(f"      {len(items)} articles from {jr['journals']} journals")

    pushed = set(load_pushed())
    fresh = [x for x in items if (x.get("doi") or "").lower() not in pushed]
    print(f"      {len(fresh)} not yet covered ({len(pushed)} in pushed.txt)")

    picks = bs.curate(fresh, a.n) if fresh else []
    if not picks:
        print("no fresh candidates — nothing to do")
        return 0

    papers = "\n".join(paper_block(i + 1, p) for i, p in enumerate(picks))
    prompt = PROMPT.format(n=len(picks), papers=papers)
    print(f"[2/4] built prompt for {len(picks)} papers "
          f"({len(prompt)} chars ≈ {len(prompt)//2} tokens)")

    if a.dry_run:
        print("\n--- PROMPT ---\n" + prompt)
        print("\n(dry run: model not called)")
        return 0

    if not key:
        print("ERROR: no API key. Set LLM_API_KEY (or DEEPSEEK_API_KEY) as a repo secret.",
              file=sys.stderr)
        return 2

    print(f"[3/4] calling {model} at {base} ...")
    raw = call_llm(base, key, model, prompt)
    parsed = extract_json(raw)

    by_idx = {int(x["index"]): x for x in parsed.get("items", []) if "index" in x}
    top = parsed.get("topPick") or {}
    top_idx = int(top.get("index", 0) or 0)

    out_items = []
    for i, p in enumerate(picks, start=1):
        got = by_idx.get(i, {})
        row = {
            "doi": (p.get("doi") or "").lower(),
            "title": p.get("title"),
            "journal": p.get("journal"),
            "domain": p.get("domain"),
            "basic": bool(p.get("basic")),
            "studyKey": p.get("studyKey"),
            "studyZh": p.get("studyZh"),
            "date": p.get("date"),
            "topPick": i == top_idx,
            "topReason": (top.get("reason") or "").strip() if i == top_idx else "",
        }
        for f in FIELDS:
            row[f] = (got.get(f) or "").strip()
        out_items.append(row)

    digest = {
        "date": date.today().isoformat(),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": model,
        "count": len(out_items),
        "items": out_items,
    }
    with open(DIGEST, "w", encoding="utf-8") as f:
        json.dump(digest, f, ensure_ascii=False, indent=1)

    save_pushed([d.lower() for d in load_pushed()] + [x["doi"] for x in out_items if x["doi"]])

    print(f"[4/4] wrote {os.path.relpath(DIGEST, HERE)} — {len(out_items)} items")
    for x in out_items:
        flag = " ★今日首选" if x["topPick"] else ""
        print(f"      [{x['studyZh']}] {x['journal']:<16} {x['doi'][:38]}{flag}")
        for f in FIELDS:
            print(f"        {FIELD_ZH[f]}: {(x.get(f) or '')[:62]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
