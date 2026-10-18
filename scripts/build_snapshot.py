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

stdlib only.  Usage:  python build_snapshot.py [--days 15]
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
# Three ISSN slices, each walked with cursorMark until every journal in the
# slice has `cap` abstracts or the result set ends. A single page of 100
# sorted by date lets Science / Sci Adv / Cell Reports fill the page.
EPMC_PAGE = 100
EPMC_CHUNK_PAGES = 15

# 15-day pool. firstPublicationDate older than today-minus-days is absent.
# Among flagship + sub articles the target is 7:3
# (FLAGSHIP_SHARE). Specialty journals are outside that ratio.
# Every sub journal that published keeps one seat, then each domain is
# filled to DOMAIN_FLOOR when the window has the papers. Further subs are
# added only until the 30% share, and only up to SUB_CAP, so a typical
# companion stays at 1–3 papers while a one-journal field can reach 6.
# The seat-plus-floor passes can land the flagship share under 70% when
# they already use more than 30% of the flagship+sub slice. Pool ~300–400.
FLAGSHIP_CAP = 28
SUB_CAP = 3
SPECIALTY_CAP = 6
TIER_CAP = {"flagship": FLAGSHIP_CAP, "sub": SUB_CAP, "specialty": SPECIALTY_CAP}
FLAGSHIP_SHARE = 0.70
DOMAIN_FLOOR = 6
POOL_MAX = 400
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
    # a bare "meta-analys" is not enough — GWAS papers report a "combined meta-analysis"
    ("meta", "荟萃分析", 6,
     r"systematic review and meta-analys|in this meta-analys|"
     r"we (conducted|performed|did) a meta-analys|meta-analysis of \d|"
     r"network meta-analys|individual participant data|pooled analysis of \d"),
    ("gwas", "遗传关联研究", 5,
     r"genome[- ]wide association stud|(?<![A-Za-z])GWAS(?![A-Za-z])|mendelian randomi[sz]ation|"
     r"exome[- ]wide association|polygenic (risk )?score"),
    ("emulation", "目标试验模拟", 4,
     r"target trial emulation|emulat(e|ing|ed) a (pragmatic |hypothetical )?target trial"),
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


def tier_name(a):
    t = (a or {}).get("tier")
    return t if t in TIER_CAP else "specialty"


def tier_bonus(a):
    return {"flagship": 2, "specialty": 1, "sub": 0}[tier_name(a)]


def curate(items, n=8, n_basic=4, n_clinical=4):
    """今日精选：n 篇 = n_clinical 篇临床 + n_basic 篇基础/分子医学。

    Flagships are taken first (one journal each, then a second clinical
    paper from a flagship). Specialty fills what flagships cannot, then subs.
    Basic slots stay one per journal so Cell cannot occupy every basic seat.
    """
    def rank(a):
        return (tier_bonus(a) * 100000 + a["studyRank"] * 1000
                + (a.get("imp") or 0) + (40 if a["structured"] else 0))

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

    for it in pool:                                    # 基础旗舰，一刊一篇
        if cnt(True) >= n_basic:
            break
        if it["basic"] and tier_name(it) == "flagship":
            add(it, 1)

    for it in pool:                                    # 临床旗舰，先一刊一篇再允许第二篇
        if cnt(False) >= n_clinical:
            break
        if not it["basic"] and tier_name(it) == "flagship":
            add(it, 1)
    for it in pool:
        if cnt(False) >= n_clinical:
            break
        if not it["basic"] and tier_name(it) == "flagship":
            add(it, 2)

    for it in pool:                                    # 基础其余名额，一刊一篇
        if cnt(True) >= n_basic:
            break
        if it["basic"]:
            add(it, 1)

    for it in pool:                                    # 临床其余名额，优先不同领域
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

    for it in pool:                                    # 一刊上限仍挡路时放开，池子够大就凑满 n
        if len(picked) >= n:
            break
        add(it, 99)

    return sorted(picked[:n], key=rank, reverse=True)


def keyword_list(raw):
    """Europe PMC keywordList → plain strings. Mirrors assets/app.js keywordList."""
    if not raw:
        return []
    if isinstance(raw, dict):
        raw = raw.get("keyword") or []
    if isinstance(raw, str):
        raw = [raw]
    out = []
    for k in raw:
        if isinstance(k, dict):
            k = k.get("text") or k.get("value") or ""
        t = clean(str(k or ""))
        if t:
            out.append(t)
    return out


def index_journals(cfg):
    """Map both print ISSN and eISSN onto the config row."""
    by = {}
    for c in cfg:
        for key in (c.get("issn"), c.get("essn")):
            if key:
                by[key] = c
    return by


def record_issns(record):
    """ISSNs Europe PMC may put on a core record or a lite journalIssn string."""
    j = ((record.get("journalInfo") or {}).get("journal") or {})
    found = []
    for key in (j.get("issn"), j.get("essn")):
        if key and key not in found:
            found.append(key)
    for part in re.split(r"[;,]", str(record.get("journalIssn") or "")):
        part = part.strip()
        if part and part not in found:
            found.append(part)
    return found, j


def match_journal(record, by_issn):
    """Config row for whichever of issn / essn this record actually carries."""
    ids, j = record_issns(record)
    for key in ids:
        hit = by_issn.get(key)
        if hit:
            return hit, j
    return {}, j


def fetch_journal_chunk(chunk, by_issn, lo, hi):
    """Page one ISSN slice until each journal has its tier cap, or the cursor ends.

    Returns the kept core records (already capped per configured journal).
    """
    issns = []
    for c in chunk:
        for key in (c.get("issn"), c.get("essn")):
            if key and key not in issns:
                issns.append(key)
    if not issns:
        return []
    q = ("(" + " OR ".join(f'ISSN:"{i}"' for i in issns) + ")"
         + f" AND SRC:MED AND HAS_ABSTRACT:Y AND FIRST_PDATE:[{lo} TO {hi}]")
    counts = {c["issn"]: 0 for c in chunk if c.get("issn")}
    caps = {c["issn"]: pool_cap(c.get("tier") or "specialty") for c in chunk if c.get("issn")}
    cursor, kept, seen = "*", [], set()
    pages = 0
    for _ in range(EPMC_CHUNK_PAGES):
        pages += 1
        url = EPMC + "?" + urllib.parse.urlencode(
            {"query": q, "format": "json", "pageSize": str(EPMC_PAGE),
             "resultType": "core", "sort": "P_PDATE_D desc", "cursorMark": cursor})
        data = get(url)
        rows = data.get("resultList", {}).get("result", []) or []
        if not rows:
            break
        for r in rows:
            meta, _j = match_journal(r, by_issn)
            key = (r.get("doi") or r.get("id") or r.get("pmid") or "").lower()
            if not meta or not key or key in seen:
                continue
            issn = meta.get("issn") or ""
            if counts.get(issn, 0) >= caps.get(issn, pool_cap("specialty")):
                continue
            seen.add(key)
            counts[issn] = counts.get(issn, 0) + 1
            kept.append(r)
        if counts and all(counts.get(c.get("issn"), 0) >= caps.get(c.get("issn"), pool_cap("specialty")) for c in chunk):
            break
        nxt = data.get("nextCursorMark")
        if not nxt or nxt == cursor:
            break
        cursor = nxt
        time.sleep(0.35)
    print(f"      chunk {len(chunk)} journals, {pages} page(s), kept {len(kept)}")
    return kept


def pool_cap(tier):
    """Per-journal ceiling before the 7:3 trim.

    Subs are allowed up to the domain floor. A field whose only title is a
    companion journal can still reach DOMAIN_FLOOR. The 7:3 budget is what
    holds a typical sub to one or two papers once every floor is met.
    """
    if tier == "sub":
        return max(SUB_CAP, DOMAIN_FLOOR)
    return TIER_CAP[tier]


def compose_pool(items):
    """Flagships and specialty journals stay. Subs fill domain floors, then the 30% share.

    Newest papers win when a cap binds. Specialty articles are outside the
    7:3 split. After floors, more subs are added until flagships are about
    70% of (flagship + sub), spread across sub journals and higher IF first.
    If the floors alone already use up that 30%, no further subs are added
    and the flagship share lands under 70%. Above POOL_MAX, the oldest
    specialty papers in domains already past the floor go first.
    """
    ordered = sorted(items, key=lambda a: a.get("date") or "", reverse=True)
    per, capped = {}, []
    for a in ordered:
        cap = pool_cap(tier_name(a))
        n = per.get(a["journal"], 0)
        if n >= cap:
            continue
        per[a["journal"]] = n + 1
        capped.append(a)

    flagship = [a for a in capped if tier_name(a) == "flagship"]
    subs = [a for a in capped if tier_name(a) == "sub"]
    specialty = [a for a in capped if tier_name(a) == "specialty"]
    kept = flagship + specialty
    kept_ids = {a.get("id") for a in kept}
    # One seat per sub journal that actually published, so a companion title
    # is not erased when its domain is already full of flagship or specialty papers.
    seen_sub = set()
    for a in subs:
        j = a["journal"]
        if j in seen_sub:
            continue
        seen_sub.add(j)
        kept.append(a)
        kept_ids.add(a.get("id"))

    def domain_count(domain):
        return sum(1 for a in kept if a.get("domain") == domain)

    domains, seen_d = [], set()
    for a in capped:
        d = a.get("domain") or "综合医学"
        if d not in seen_d:
            seen_d.add(d)
            domains.append(d)
    for domain in domains:
        need = DOMAIN_FLOOR - domain_count(domain)
        if need <= 0:
            continue
        extra = [a for a in capped if a.get("domain") == domain and a.get("id") not in kept_ids]
        extra.sort(key=lambda a: a.get("date") or "", reverse=True)
        for a in extra:
            if need <= 0:
                break
            kept.append(a)
            kept_ids.add(a.get("id"))
            need -= 1

    target_sub = (int(round(len(flagship) * (1 - FLAGSHIP_SHARE) / FLAGSHIP_SHARE))
                  if flagship else len(subs))
    current_sub = sum(1 for a in kept if tier_name(a) == "sub")
    budget = max(0, target_sub - current_sub)
    groups, order = {}, []
    for a in subs:
        if a.get("id") in kept_ids:
            continue
        j = a["journal"]
        if j not in groups:
            groups[j] = []
            order.append(j)
        groups[j].append(a)
    order.sort(key=lambda j: groups[j][0].get("imp") or 0, reverse=True)
    per_sub = {}
    for a in kept:
        if tier_name(a) == "sub":
            per_sub[a["journal"]] = per_sub.get(a["journal"], 0) + 1
    added = 0
    while added < budget:
        moved = False
        for j in order:
            if added >= budget:
                break
            if per_sub.get(j, 0) >= SUB_CAP:
                continue
            if groups[j]:
                a = groups[j].pop(0)
                kept.append(a)
                kept_ids.add(a.get("id"))
                per_sub[j] = per_sub.get(j, 0) + 1
                added += 1
                moved = True
        if not moved:
            break

    if len(kept) > POOL_MAX:
        def live_count(domain):
            return sum(1 for a in kept if a.get("id") not in drop and a.get("domain") == domain)
        drop = set()
        extras = [a for a in kept if tier_name(a) == "specialty"]
        extras.sort(key=lambda a: a.get("date") or "")
        for a in extras:
            if len(kept) - len(drop) <= POOL_MAX:
                break
            if live_count(a.get("domain")) <= DOMAIN_FLOOR:
                continue
            drop.add(a.get("id"))
        kept = [a for a in kept if a.get("id") not in drop]

    kept.sort(key=lambda a: a.get("date") or "", reverse=True)
    return kept


def build_journals(days, cap_per_journal=8):
    """Query Europe PMC in ISSN slices, paging each slice so every journal is represented.

    A single page of 100 sorted by date lets a high-volume title fill the page.
    Each slice is walked with cursorMark until every journal has its tier cap
    or the result set ends. `cap_per_journal` is unused; caps come from TIER_CAP.
    Print ISSN and eISSN both join to the config row.
    """
    cfg = json.load(open(os.path.join(DATA, "journals.config.json"), encoding="utf-8"))
    by_issn = index_journals(cfg)

    hi = date.today().isoformat()
    lo = (date.today() - timedelta(days=days)).isoformat()

    step = max(1, (len(cfg) + 2) // 3)
    chunks = [cfg[i:i + step] for i in range(0, len(cfg), step)]

    merged, seen = [], set()
    for ch in chunks:
        for r in fetch_journal_chunk(ch, by_issn, lo, hi):
            key = (r.get("doi") or r.get("id") or r.get("pmid") or "").lower()
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(r)
        time.sleep(0.35)

    cands = []
    for r in merged:
        meta, j = match_journal(r, by_issn)
        ids, _j = record_issns(r)
        issn = ids[0] if ids else ""
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
            "issn": meta.get("issn") or issn,
            # copied from journals.config.json so a snapshot item still knows
            # which full-text button to show if the config row cannot be joined
            "platforms": list(meta.get("platforms") or []),
            "domain": meta.get("domain") or "综合医学",
            "tier": meta.get("tier") or "specialty",
            "imp": meta.get("if", 0),
            "basic": is_basic,
            "studyKey": study, "studyZh": STUDY_ZH.get(study, "研究论文"),
            "studyRank": STUDY_RANK.get(study, 3),
            "stars": stars(meta.get("if", 0)),
            "date": d, "ts": 0,
            "year": r.get("pubYear") or (d[:4] if d else ""),
            "authors": (clean(r.get("authorString")).split(",") or [""])[0],
            "pmid": r.get("pmid") or "", "doi": r.get("doi") or "",
            "keywords": keyword_list(r.get("keywordList")),
            "volume": ((r.get("journalInfo") or {}).get("volume") or ""),
            "issue": ((r.get("journalInfo") or {}).get("issue") or ""),
            "pages": r.get("pageInfo") or "",
            "oa": str(r.get("isOpenAccess") or "").strip().upper() in {"Y", "TRUE", "1"},
        })

    items = compose_pool(cands)

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
    ap.add_argument("--days", type=int, default=15)
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
    focus = ("NEJM", "BMJ", "Nature")
    got = Counter(x["journal"] for x in jr["items"])
    print("      重点: " + ", ".join(f"{name} {got.get(name, 0)}" for name in focus))
    tiers = Counter(x.get("tier") or "specialty" for x in jr["items"])
    fs, sb = tiers.get("flagship", 0), tiers.get("sub", 0)
    mix = (fs / (fs + sb)) if (fs + sb) else 0
    print(f"      层级: flagship {fs} / sub {sb} / specialty {tiers.get('specialty', 0)}"
          f"  | 旗舰占旗舰+子刊 {mix:.0%}")

    print("[2/2] builders ...")
    try:
        bd = build_builders()
        json.dump(bd, open(os.path.join(DATA, "snapshot-builders.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print(f"      {len(bd['items'])} posts, feed generatedAt {bd['generatedAt']}")
    except Exception as e:
        # 优雅降级：上游 zarazhangrui/follow-builders 偶发 4xx/超时/限流时，
        # 不要把整个 workflow 拖死 —— journals 已经在 [1/2] 写好，至少把它 commit 出去。
        # 旧的 snapshot-builders.json 保留作离线 fallback；前端 loadBuilders() 本来就
        # 是直接 live fetch 上游，这里挂掉最多让 fallback 快照旧一点。
        print(f"      [WARN] builders feed 拉取失败，跳过本次 snapshot-builders.json: {e}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
