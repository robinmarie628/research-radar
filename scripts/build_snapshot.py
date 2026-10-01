#!/usr/bin/env python3
"""Build the fallback snapshots for 科研雷达.

The web app fetches live data on open; these snapshots are the offline / API-down
safety net and the payload the optional GitHub Action refreshes daily.

Mirrors the client logic in assets/app.js:
  - 领域 (domain) comes from the journal config, not from keyword guessing
  - 研究类型 (study design) is read out of the abstract, because pubTypes is
    almost always just ["Journal Article"]
  - structured abstracts are split into 目的/方法/结果/结论

Writes:
  data/snapshot-journals.json   Europe PMC articles (classified)
  data/snapshot-builders.json   follow-builders X / blog / podcast items

stdlib only.  Usage:  python build_snapshot.py [--days 30]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
FEED = "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/"
UA = "research-radar/1.0 (mailto:robinmarie628@users.noreply.github.com)"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

TAG_RE = re.compile(r"<[^>]*>")
ENT = [("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&apos;", "'"),
       ("&nbsp;", " "), ("&amp;", "&")]

# ---- 研究类型 (mirrors STUDY in app.js; order == priority) --------------------
STUDY = [
    ("guideline", "指南/共识", 6,
     r"(clinical )?practice guideline|consensus (statement|document|recommendation)|"
     r"expert consensus|society (guideline|recommendation)|guideline[- ]directed"),
    ("meta", "荟萃分析", 6,
     r"systematic review and meta-analys|meta-analys|individual participant data|"
     r"pooled analysis of \d|network meta-analys"),
    ("rct", "随机对照试验", 6,
     r"randomi[sz]ed (controlled |clinical |placebo[- ]controlled )?(trial|study)|"
     r"randomly (assigned|allocated)|double[- ]blind|placebo[- ]controlled|1:1 (ratio )?randomi"),
    ("gdb", "疾病负担分析", 5,
     r"global burden of disease|global, regional, and national (burden|prevalence|estimates)|"
     r"disability[- ]adjusted life|\bdalys?\b"),
    ("multicenter", "多中心研究", 5,
     r"multicent(er|re)|multinational|multisite|\d+ (sites|centres|centers|hospitals) (in|across)|"
     r"across \d+ countries"),
    ("cohort", "前瞻队列", 5,
     r"prospective (cohort|observational|population|registry|study)|population[- ]based cohort|"
     r"nationwide (cohort|register)|longitudinal (cohort|study)|community[- ]based cohort"),
    ("registry", "注册研究", 4,
     r"\bregistry\b|real[- ]world (evidence|data|cohort)|nationwide (register|database)"),
    ("basic", "基础研究", 4,
     r"\bmice\b|\bmurine\b|\brats?\b|in vitro|in vivo|knockout|organoid|"
     r"single[- ]cell (rna|sequencing|transcriptom)|transcriptom|CRISPR|western blot|"
     r"cryo-?EM|xenograft|cell line"),
    ("casecontrol", "病例对照", 3, r"case[- ]control|nested case[- ]control"),
    ("retrospective", "回顾性研究", 3,
     r"retrospective (cohort|study|analysis|review)|chart review|medical records"),
    ("review", "综述", 2,
     r"this review|we review|narrative review|state[- ]of[- ]the[- ]art review|"
     r"review (summari[sz]es|discusses|highlights)|in this (review|overview)|scoping review"),
    ("editorial", "评论/社论", 1, r"this (editorial|commentary|viewpoint)|we (argue|contend) that"),
]
STUDY_RE = {k: re.compile(p, re.I) for k, _zh, _r, p in STUDY}
STUDY_ZH = {k: zh for k, zh, _r, _p in STUDY}
STUDY_RANK = {k: r for k, _zh, r, _p in STUDY}
STUDY_ZH["other"] = "研究论文"
STUDY_RANK["other"] = 3

PT_STRONG = [
    (re.compile(r"Randomized Controlled Trial|Clinical Trial, Phase (II|III|IV)", re.I), "rct"),
    (re.compile(r"Practice Guideline|Guideline", re.I), "guideline"),
    (re.compile(r"Meta-Analysis", re.I), "meta"),
    (re.compile(r"Multicenter Study", re.I), "multicenter"),
]

# ---- abstract section headings (mirrors SEC_HEAD in app.js) ------------------
SEC_HEAD = [
    ("objective", re.compile(
        r"^(background|objectives?|aims?|purpose|research question|rationale|introduction|"
        r"importance|context|question|hypothesis|why (did|do) we|what is known|unmet need|"
        r"significance of this study|summary|overview|topic|topic importance|"
        r"impact and implications)", re.I)),
    ("methods", re.compile(
        r"^(methods?|materials and methods|study design|design|patients and methods|setting|"
        r"approach|experimental approach|patients|participants|subjects?|data sources|"
        r"study selection|study population|exposure|interventions?|procedures?|measurements?|"
        r"main outcomes? (and )?measures?|outcomes? and measures|data collection|"
        r"statistical analysis|study (design|population|setting|sample)|structure)", re.I)),
    ("results", re.compile(
        r"^(results?|findings|main results|results? and discussion|"
        r"measurements? and main results?|outcomes?|analysis|key results|review findings)", re.I)),
    ("conclusion", re.compile(
        r"^(conclusions?|interpretation|discussion|significance|outlook|perspectives?|"
        r"implications?|meaning|conclusions? and relevance|clinical (implications?|relevance)|"
        r"future (directions|perspectives)|concluding remarks|translations?)", re.I)),
]
SEC_SKIP = re.compile(
    r"^(clinical trial registration|trial registration|registration|funding|"
    r"systematic review registration|conflict of interest|declarations? of interest|"
    r"financial disclosure|transparency|author contributions?|copyright|"
    r"data (availability|sharing)|acknowledg|supplementary|ethics|"
    r"role of the funding|abbreviations)", re.I)
HEAD_RE = re.compile(r"<(h[1-6]|b|strong)>([^<]{2,60}?)</\1>", re.I)


def clean(s):
    """Decode entities FIRST, then strip tags.

    Order matters: Europe PMC double-encodes markup, so a tag-strip before entity
    decoding leaves `&lt;sup&gt;` behind, which then becomes a literal `<sup>`.
    """
    if not s:
        return ""
    s = str(s)
    for _ in range(2):
        for a, b in ENT:
            s = s.replace(a, b)
        s = TAG_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_abstract(raw):
    """Split a structured abstract into 目的/方法/结果/结论.

    Runs on the RAW text because the headings ARE the tags. Gene names also appear
    in <i>/<b> markup (TRAF7, Cxcl1, …), so a candidate only counts as a heading
    when it matches a known section vocabulary.
    """
    text = str(raw or "")
    marks = []
    for m in HEAD_RE.finditer(text):
        label = m.group(2).rstrip(": ").strip()
        if any(re_.match(label) for _k, re_ in SEC_HEAD) or SEC_SKIP.match(label):
            marks.append((label, m.start(), m.end()))
    if not marks:
        return {"structured": False, "sections": None, "text": clean(text)}

    acc = {k: [] for k in ("objective", "methods", "results", "conclusion", "other")}
    if marks[0][1] > 0:
        lead = clean(text[:marks[0][1]])
        if lead:
            acc["other"].append(lead)
    for i, (label, _s, e) in enumerate(marks):
        body = text[e: marks[i + 1][1] if i + 1 < len(marks) else len(text)]
        if SEC_SKIP.match(label):
            continue
        slot = "other"
        for key, re_ in SEC_HEAD:
            if re_.match(label):
                slot = key
                break
        c = clean(body)
        if c:
            acc[slot].append(c)

    sections = {k: " ".join(v).strip() for k, v in acc.items()}
    if not any(sections[k] for k in ("objective", "methods", "results", "conclusion")):
        return {"structured": False, "sections": None, "text": clean(text)}
    return {"structured": True, "sections": sections, "text": ""}


def detect_study(title, abstract, is_basic, pub_types):
    t = ((title or "") + " " + (abstract or ""))[:5000]
    pt = " | ".join(pub_types or [])
    if is_basic:
        return "review" if (STUDY_RE["review"].search(t) or re.search(r"\bReview\b", pt, re.I)) else "basic"
    for re_, key in PT_STRONG:
        if re_.search(pt):
            return key
    for key, _zh, _r, _p in STUDY:
        if STUDY_RE[key].search(t):
            return key
    if re.search(r"\bReview\b", pt, re.I):
        return "review"
    return "other"


def stars(imp):
    return 5 if imp >= 30 else 4 if imp >= 15 else 3 if imp >= 8 else 2 if imp >= 4 else 1


def get(url, tries=4, timeout=45):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 + i * 2)
    raise RuntimeError(f"{url[:90]} -> {last}")


def curate(items, n=8, n_basic=4, n_clinical=4):
    """今日精选：n 篇 = n_clinical 篇临床 + n_basic 篇基础/分子医学。

    · 基础名额一刊一篇 —— 否则一本刊（如 Cell）能占满，出现两篇几乎雷同的论文
    · 临床名额优先覆盖不同领域
    · 某一边候选不足时，用另一边补足总数
    """
    def rank(a):
        return a["studyRank"] * 1000 + (a.get("imp") or 0) + (40 if a["structured"] else 0)

    pool = sorted(items, key=rank, reverse=True)
    picked, per_j, per_d = [], {}, {}

    def add(it, j_cap):
        if it in picked:
            return False
        if per_j.get(it["journal"], 0) >= j_cap:
            return False
        picked.append(it)
        per_j[it["journal"]] = per_j.get(it["journal"], 0) + 1
        per_d[it["domain"]] = per_d.get(it["domain"], 0) + 1
        return True

    def cnt(basic):
        return sum(1 for p in picked if bool(p["basic"]) is basic)

    for it in pool:                                    # 基础：目标 n_basic，一刊一篇
        if cnt(True) >= n_basic:
            break
        if it["basic"]:
            add(it, 1)

    for it in pool:                                    # 临床：目标 n_clinical，优先不同领域
        if cnt(False) >= n_clinical:
            break
        if not it["basic"] and not per_d.get(it["domain"]):
            add(it, 2)

    for it in pool:
        if cnt(False) >= n_clinical:
            break
        if not it["basic"]:
            add(it, 2)

    for it in pool:                                    # 补足
        if len(picked) >= n:
            break
        add(it, 2)

    return sorted(picked[:n], key=rank, reverse=True)


def build_journals(days, cap_per_journal=8):
    """Query Europe PMC in chunks, merge, then cap per journal.

    A single query lets one high-volume journal (Nat Commun publishes ~2282 items
    per quarter) crowd out every other title, so we split the ISSN list and rebalance.
    """
    cfg = json.load(open(os.path.join(DATA, "journals.config.json"), encoding="utf-8"))
    by_issn = {c["issn"]: c for c in cfg}

    hi = date.today().isoformat()
    lo = (date.today() - timedelta(days=days)).isoformat()

    step = (len(cfg) + 2) // 3
    chunks = [cfg[i:i + step] for i in range(0, len(cfg), step)]

    merged, seen = [], set()
    for ch in chunks:
        issn_q = " OR ".join(f'ISSN:"{c["issn"]}"' for c in ch)
        q = f"({issn_q}) AND SRC:MED AND HAS_ABSTRACT:Y AND FIRST_PDATE:[{lo} TO {hi}]"
        url = EPMC + "?" + urllib.parse.urlencode(
            {"query": q, "format": "json", "pageSize": "100",
             "resultType": "core", "sort": "P_PDATE_D desc"})
        for r in get(url).get("resultList", {}).get("result", []):
            key = (r.get("doi") or r.get("id") or r.get("pmid") or "").lower()
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(r)
        time.sleep(0.4)

    cands = []
    for r in merged:
        ji = r.get("journalInfo", {}) or {}
        j = ji.get("journal", {}) or {}
        issn = j.get("issn") or j.get("essn") or ""
        meta = by_issn.get(issn, {})
        title = clean(r.get("title"))
        if not title:
            continue

        parsed = parse_abstract(r.get("abstractText"))
        is_basic = bool(meta.get("basic"))
        body = parsed["text"] or " ".join(v for v in (parsed["sections"] or {}).values())
        study = detect_study(title, body, is_basic, r.get("pubTypeList", {}).get("pubType", []))
        d = r.get("firstPublicationDate") or r.get("electronicPublicationDate") or ""

        cands.append({
            "id": (r.get("doi") or r.get("id") or r.get("pmid") or "").lower(),
            "title": title,
            "abstract": parsed["text"],
            "sections": parsed["sections"],
            "structured": parsed["structured"],
            "journal": meta.get("short") or j.get("medlineAbbreviation") or "—",
            "domain": meta.get("domain") or "综合医学",
            "imp": meta.get("if", 0),
            "basic": is_basic,
            "studyKey": study, "studyZh": STUDY_ZH.get(study, "研究论文"),
            "studyRank": STUDY_RANK.get(study, 3),
            "stars": stars(meta.get("if", 0)),
            "date": d, "ts": 0,
            "year": r.get("pubYear") or (d[:4] if d else ""),
            "authors": (clean(r.get("authorString")).split(",") or [""])[0],
            "pmid": r.get("pmid") or "", "doi": r.get("doi") or "",
            "oa": bool(r.get("isOpenAccess")),
        })

    cands.sort(key=lambda x: x["date"], reverse=True)
    items, per_journal = [], {}
    for c in cands:
        if per_journal.get(c["journal"], 0) >= cap_per_journal:
            continue
        per_journal[c["journal"]] = per_journal.get(c["journal"], 0) + 1
        items.append(c)

    return {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "windowDays": days, "journals": len(cfg), "rawFetched": len(merged),
            "updated": items[0]["date"] if items else None,
            "picks": curate(items),
            "items": items}


def build_builders():
    x = get(FEED + "feed-x.json")
    blogs = get(FEED + "feed-blogs.json")
    pods = get(FEED + "feed-podcasts.json")

    out = []
    for b in x.get("x", []):
        for t in b.get("tweets", []):
            out.append({"type": "x", "kind": "X 动态",
                        "name": b.get("name") or b.get("handle"), "handle": b.get("handle", ""),
                        "text": clean(t.get("text")), "date": t.get("createdAt", ""), "ts": 0,
                        "url": t.get("url", ""), "likes": t.get("likes", 0),
                        "rt": t.get("retweets", 0), "replies": t.get("replies", 0)})
    for b in blogs.get("blogs", []):
        out.append({"type": "blog", "kind": "官方博客", "name": b.get("name", "Blog"),
                    "handle": "", "title": clean(b.get("title")),
                    "text": clean(b.get("description") or b.get("content"))[:1200],
                    "date": b.get("publishedAt", ""), "ts": 0, "url": b.get("url", "")})
    for p in pods.get("podcasts", []):
        out.append({"type": "podcast", "kind": "播客", "name": p.get("name") or p.get("show", "Podcast"),
                    "handle": "", "title": clean(p.get("title")),
                    "text": clean(p.get("description") or p.get("summary")),
                    "date": p.get("publishedAt") or p.get("date", ""), "ts": 0, "url": p.get("url", "")})

    out = [o for o in out if o.get("text") or o.get("title")]
    out.sort(key=lambda o: o.get("date", ""), reverse=True)
    return {"generatedAt": x.get("generatedAt") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "updated": x.get("generatedAt"), "items": out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    a = ap.parse_args()

    print(f"[1/2] journals (last {a.days}d) ...")
    jr = build_journals(a.days)
    json.dump(jr, open(os.path.join(DATA, "snapshot-journals.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    from collections import Counter
    print(f"      {len(jr['items'])} articles (raw {jr['rawFetched']}), newest {jr['updated']}")
    print(f"      领域: {dict(Counter(x['domain'] for x in jr['items']))}")
    print(f"      类型: {dict(Counter(x['studyZh'] for x in jr['items']))}")
    print(f"      临床 {sum(1 for x in jr['items'] if not x['basic'])} / 基础 {sum(1 for x in jr['items'] if x['basic'])}"
          f"  | 结构化摘要 {sum(1 for x in jr['items'] if x['structured'])}")
    print(f"      今日精选 {len(jr['picks'])} 篇 (基础 {sum(1 for p in jr['picks'] if p['basic'])})")

    print("[2/2] builders ...")
    bd = build_builders()
    json.dump(bd, open(os.path.join(DATA, "snapshot-builders.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"      {len(bd['items'])} posts, feed generatedAt {bd['generatedAt']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
