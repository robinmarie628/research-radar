#!/usr/bin/env python3
"""Generate 通俗版五段摘要 for the daily shortlist via an OpenAI-compatible LLM.

Fields: 背景 / 创新点 / 怎么做的 / 看点·临床含义 / 未来研究方向

Reuses build_snapshot.py for the Europe PMC fetch + 今日精选 curation, so the
digest always matches what the page shows.

Output  data/digest.json   — read by the app; fields keyed by DOI
        data/pushed.txt    — DOIs already covered, so days don't repeat

Provider defaults to DeepSeek but any OpenAI-compatible endpoint works:
    LLM_BASE_URL   (default https://api.deepseek.com)
    LLM_MODEL      (default deepseek-flash)
    LLM_API_KEY / DEEPSEEK_API_KEY

stdlib only.  Usage:  python build_digest.py [--n 8] [--dry-run]

The shortlist is always exactly --n papers (default 8 = 4 clinical + 4 basic).
Fresh (not-yet-pushed) papers are preferred. If that side of the pool is short,
already-covered papers from the same window fill the gap. The script refuses to
overwrite digest.json when it cannot hit that split.
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
DEFAULT_MODEL = "deepseek-flash"
MAX_ABSTRACT = 2600          # chars per paper fed to the model
PUSHED_KEEP = 400            # remember this many DOIs

# field order used when writing digest.json (and rendered in this order by the page)
FIELDS = ["background", "methods", "innovation", "takeaway", "future"]
FIELD_ZH = {"background": "背景", "innovation": "创新", "methods": "做法",
            "takeaway": "看点", "future": "未来"}

SYSTEM = (
    "你是临床医学编辑，为医生撰写每日顶刊速递。"
    "你的读者是临床医生和医学生，不是本领域的专家。"
    "你只依据给出的摘要原文写作，绝不推测或编造任何信息。"
)

PROMPT = """下面是从顶刊筛选出的 {n} 篇论文，每篇附标题、期刊、领域、研究类型与摘要原文。

请为每一篇写一段**大白话**介绍，语气就像跟同科室的同事聊天，解释「这篇为什么能上顶刊」。
用五个部分组织，说人话、少堆术语，能用日常语言讲清楚的就别用行话：

① background（背景）：这个病 / 这个问题为什么重要？此前卡在哪、缺什么？2–3 句。
② methods（怎么做的）：研究到底怎么做的——找了什么人、怎么分组、比了什么、看什么结局。
   像讲故事一样说清楚，不要照抄方法学名词。2–3 句。
③ innovation（创新点）：这篇新在哪？为什么值得上顶刊？1–2 句。
④ takeaway（看点 / 临床含义）：关键结果是什么（**给出具体数字**）？对临床决策意味着什么？
   有争议或局限也直说。2–3 句。
⑤ future（未来研究方向）：**不要写「摘要未提及」**。基于摘要里已经写出的结果、机制、
   人群或信号，给出 1–2 个合理、有意义、值得做的后续方向。这是唯一允许"超出摘要"的部分，
   但必须是从摘要内容自然推出来的，不能凭空发挥。

另外，为每一篇写 titleZh（中文标题）：

- 概括这篇论文在做什么，保留专有名词 / 药物名 / 试验名 / 基因名的英文原文
  （如 ROAM/EORTC-1308、APOE4、BCL11A）
- 只写标题本身。不要在末尾追加（刊名，领域，研究类型），刊名、领域、研究类型页面上另有位置
- 标题正文里本来就有的括号要保留，例如缩写（ASCVD）或试验名
- 不加书名号，结尾不加句号

再从这 {n} 篇中选出 1 篇作为「今日首选」，给出 1 句理由（选证据等级最高、临床影响最大的一篇）。

写作要求：
1. **大白话**：像给同科室同事讲，不是写给审稿人。句子短，多用主动语态，
   不要照抄英文句式和被动语态，不要堆术语。
2. 必须出现的专业名词保留英文原词（hazard ratio、intention-to-treat、non-inferiority 等），
   并且**顺手用一句话解释它是什么意思**。
3. ①②③④ 四个部分**只能使用摘要中明确写出的信息**。不得编造结果、数字或结论。
4. 数字必须与摘要完全一致；不得把亚组结果说成主要终点。
5. 每个部分 2–3 句，不超过 140 字。

只输出 JSON，不要 markdown 代码块，不要任何解释文字：
{{
  "items": [
    {{"index": 1, "titleZh": "…", "background": "…", "methods": "…", "innovation": "…", "takeaway": "…", "future": "…"}}
  ],
  "topPick": {{"index": 2, "reason": "…"}}
}}

===== 论文列表 =====
{papers}"""


def load_pushed():
    if not os.path.exists(PUSHED):
        return []
    with open(PUSHED, encoding="utf-8") as f:
        return [l.strip().lower() for l in f if l.strip()]


def save_pushed(dois):
    keep = dois[-PUSHED_KEEP:]
    with open(PUSHED, "w", encoding="utf-8") as f:
        f.write("\n".join(keep) + ("\n" if keep else ""))


# Trailing （journal，domain，study type） from the old title prompt.
# A parenthesis that is part of the title, such as （ASCVD）, has no study-type label and stays.
_STUDY_LABELS = {
    "指南/共识", "荟萃分析", "遗传关联研究", "目标试验模拟", "随机对照试验",
    "疾病负担分析", "多中心研究", "前瞻队列", "注册研究", "基础研究",
    "病例对照", "回顾性研究", "综述", "评论/社论", "研究论文",
}
_TITLE_META_RE = re.compile(
    r"(?:（|\()([^（）()]*)[，,]([^（）()]*)[，,]([^（）()]*)(?:）|\))\s*$"
)
_JOURNAL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .:&/+-]{0,48}$")
_DOMAIN_RE = re.compile(r"^[\u4e00-\u9fff]{2,8}(?:与[\u4e00-\u9fff]{1,6})?$")


def strip_title_meta(text):
    s = (text or "").strip()
    m = _TITLE_META_RE.search(s)
    if not m:
        return s
    journal, domain, kind = (p.strip() for p in m.groups())
    if _JOURNAL_RE.match(journal) and _DOMAIN_RE.match(domain) and kind in _STUDY_LABELS:
        return s[:m.start()].strip()
    return s


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
        # deepseek-flash defaults to thinking mode (high effort); for this simple
        # structured-extraction task we turn it off so reasoning tokens aren't
        # billed as output and latency stays low. Mirrors old deepseek-chat behavior.
        "thinking": {"type": "disabled"},
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


def _doi(a):
    return (a.get("doi") or a.get("id") or "").lower()


def choose_eight(fresh, full, n=8, n_basic=4, n_clinical=4):
    """Exactly n_basic basic + n_clinical clinical, or None.

    Prefer flagships, then specialty journals, then subs. Within that, prefer
    `fresh` (not in pushed.txt). Top up from `full` and relax the per-journal
    cap only after the strict pass fails. Never borrows from the other side
    to pad the total.
    """
    if n_basic + n_clinical != n:
        n_basic, n_clinical = n // 2, n - (n // 2)

    def rank(a):
        tier = {"flagship": 2, "specialty": 1}.get(a.get("tier") or "", 0)
        return tier * 100000 + (a.get("studyRank") or 0) * 1000 + (a.get("imp") or 0)

    picked, used = [], set()
    nb = nc = 0

    def take(a):
        nonlocal nb, nc
        i = _doi(a)
        if not a or not i or i in used:
            return False
        used.add(i)
        picked.append(a)
        if a.get("basic"):
            nb += 1
        else:
            nc += 1
        return True

    def fill(pool, caps):
        ordered = sorted(pool, key=rank, reverse=True)
        for cap_b, cap_c in caps:
            for a in ordered:
                basic = bool(a.get("basic"))
                if basic and nb >= n_basic:
                    continue
                if not basic and nc >= n_clinical:
                    continue
                cap = cap_b if basic else cap_c
                if sum(1 for x in picked if x.get("journal") == a.get("journal")) >= cap:
                    continue
                take(a)
            if nb >= n_basic and nc >= n_clinical:
                return

    fill(fresh or [], ((1, 1), (1, 2), (99, 99)))
    if nb < n_basic or nc < n_clinical:
        fill(full or [], ((1, 1), (1, 2), (99, 99)))
    if nb != n_basic or nc != n_clinical or len(picked) != n:
        return None
    return picked


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

    n_basic, n_clinical = a.n // 2, a.n - (a.n // 2)
    picks = choose_eight(fresh, items, a.n, n_basic, n_clinical)
    if not picks:
        nb = sum(1 for x in items if x.get("basic"))
        nc = len(items) - nb
        print(
            f"ERROR: need exactly {n_clinical} clinical + {n_basic} basic "
            f"(got a window of {nc} clinical / {nb} basic, {len(fresh)} fresh). "
            f"Refusing to overwrite digest.json.",
            file=sys.stderr,
        )
        return 1

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
            "platforms": list(p.get("platforms") or []),
            "domain": p.get("domain"),
            "basic": bool(p.get("basic")),
            "studyKey": p.get("studyKey"),
            "studyZh": p.get("studyZh"),
            "date": p.get("date"),
            "topPick": i == top_idx,
            "topReason": (top.get("reason") or "").strip() if i == top_idx else "",
        }
        row["titleZh"] = strip_title_meta(got.get("titleZh") or "")
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
        if x.get("titleZh"):
            print(f"        标题: {x['titleZh'][:56]}")
        for f in FIELDS:
            print(f"        {FIELD_ZH[f]}: {(x.get(f) or '')[:62]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
