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
  data/snapshot-journals.json   PubMed articles for the public pool (classified).
                                Europe PMC is used only if PubMed returns nothing.
  data/snapshot-builders.json   follow-builders X / blog / podcast items

The 15-day pool is PubMed `[pdat]` plus a real abstract. Europe PMC
`FIRST_PDATE` lags, which was starving Lancet (and sometimes NEJM).
最近一周 is still Crossref online dates plus PubMed abstracts.

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
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
# Empty-pool fallback only. Three ISSN slices, each walked with cursorMark
# until every journal in the slice has `cap` abstracts or the result set ends.
# A single page of 100 sorted by date lets Science / Sci Adv / Cell Reports
# fill the page. A successful PubMed fetch never mixes these rows in.
EPMC_PAGE = 100
EPMC_CHUNK_PAGES = 15

# 15-day pool caps. PubMed drops a record when neither the electronic date
# nor the issue PubDate falls inside today-minus-days (see choose_pool_date).
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
WEEK_ABS_MIN = 40
# PubMed prints a different ISSN than journals.config.json for a few titles.
# The value is the config print/electronic ISSN the row is actually filed under.
PUBMED_ISSN_ALIAS = {
    "1876-7591": "1936-878X",  # JACC Cardiovasc Imaging
    "2405-500X": "2405-5018",  # JACC Clin Electrophysiol (print; config stores electronic)
    "0009-7322": "1524-4539",  # Circulation print
    "1875-9777": "1934-5909",  # Cell Stem Cell linking ISSN
}
# Letters, errata, news, and one-paragraph commentary. High-volume titles list
# hundreds of these; they are not the public pool even when a blurb exists.
JUNK_PUBTYPES = {
    "letter", "editorial", "comment", "news", "newspaper article", "interview",
    "published erratum", "erratum", "retraction of publication",
    "retracted publication",
}
EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
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


def curate_pools(pools, n=8, n_basic=4, n_clinical=4):
    """今日精选：n 篇 = n_clinical 篇临床 + n_basic 篇基础/分子医学。

    Each pool is ranked on its own (flagship, then specialty, then sub).
    Earlier pools take seats first, so last-week online papers fill the
    shortlist before the 15-day PubMed pool tops up open seats.
    Basic slots stay one per journal so Cell cannot occupy every basic seat.
    """
    def rank(a):
        return (tier_bonus(a) * 100000 + (a.get("studyRank") or 0) * 1000
                + (a.get("imp") or 0) + (40 if a.get("structured") else 0))

    groups = [sorted(items or [], key=rank, reverse=True) for items in (pools or [])]
    picked, per_j, per_d, seen, wave = [], {}, {}, set(), {}

    def add(it, j_cap, wave_index):
        doi = article_doi(it)
        if not doi or doi in seen:
            return False
        if per_j.get(it.get("journal"), 0) >= j_cap:
            return False
        seen.add(doi)
        wave[doi] = wave_index
        picked.append(it)
        per_j[it.get("journal")] = per_j.get(it.get("journal"), 0) + 1
        per_d[it.get("domain")] = per_d.get(it.get("domain"), 0) + 1
        return True

    def cnt(basic):
        return sum(1 for p in picked if bool(p.get("basic")) is basic)

    def scan(pred, j_cap, done):
        for wave_index, pool in enumerate(groups):
            for it in pool:
                if done():
                    return
                if pred(it):
                    add(it, j_cap, wave_index)

    scan(lambda it: it.get("basic") and tier_name(it) == "flagship", 1,
         lambda: cnt(True) >= n_basic)
    scan(lambda it: not it.get("basic") and tier_name(it) == "flagship", 1,
         lambda: cnt(False) >= n_clinical)
    scan(lambda it: not it.get("basic") and tier_name(it) == "flagship", 2,
         lambda: cnt(False) >= n_clinical)
    scan(lambda it: bool(it.get("basic")), 1, lambda: cnt(True) >= n_basic)
    scan(lambda it: not it.get("basic") and not per_d.get(it.get("domain")), 2,
         lambda: cnt(False) >= n_clinical)
    scan(lambda it: not it.get("basic"), 2, lambda: cnt(False) >= n_clinical)
    scan(lambda it: True, 2, lambda: len(picked) >= n)
    scan(lambda it: True, 99, lambda: len(picked) >= n)
    # Earlier pools stay above later ones, so a last-week paper leads the
    # shortlist even when a 15-day top-up has a higher impact factor.
    return sorted(
        picked[:n],
        key=lambda a: (wave.get(article_doi(a), 0), -rank(a)),
    )


def curate(items, n=8, n_basic=4, n_clinical=4):
    return curate_pools([items], n, n_basic, n_clinical)


def article_doi(a):
    raw = ((a or {}).get("doi") or (a or {}).get("id") or "")
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", str(raw).strip().lower())


def abstract_len(a):
    if a.get("structured") and isinstance(a.get("sections"), dict):
        return sum(len(str(v or "").strip()) for v in a["sections"].values())
    return len(str(a.get("abstract") or "").strip())


def select_picks(week, pool, n=8, n_basic=4, n_clinical=4):
    """Prefer last-week online papers, then fill from the 15-day pool.

    When the same DOI is already in the 15-day pool with an abstract,
    that record is the one that gets the seat.
    """
    by = {}
    for a in pool or []:
        doi = article_doi(a)
        if doi and doi not in by:
            by[doi] = a
    preferred, seen = [], set()
    for a in week or []:
        doi = article_doi(a)
        if not doi or doi in seen or abstract_len(a) < WEEK_ABS_MIN:
            continue
        seen.add(doi)
        hit = by.get(doi)
        preferred.append(hit if hit and abstract_len(hit) >= WEEK_ABS_MIN else a)
    rest = [a for a in (pool or []) if article_doi(a) not in seen]
    return curate_pools([preferred, rest], n, n_basic, n_clinical)


SEC_HEAD = [
    ("objective", re.compile(r"^(background|objectives?|aims?|purpose|introduction|importance)", re.I)),
    ("methods", re.compile(r"^(methods?|materials and methods|study design|design|patients|participants|interventions?)", re.I)),
    ("results", re.compile(r"^(results?|findings|main results|outcomes?)", re.I)),
    ("conclusion", re.compile(r"^(conclusions?|interpretation|discussion|implications?)", re.I)),
]
SEC_SKIP = re.compile(r"^(clinical trial registration|trial registration|registration|funding|conflict of interest|copyright|data availability|ethics|acknowledg)", re.I)


def section_key(label):
    if not label or SEC_SKIP.search(label):
        return ""
    for key, cre in SEC_HEAD:
        if cre.search(label):
            return key
    return "other"


def crossref_day(item):
    online = (item.get("published-online") or item.get("issued") or {}).get("date-parts") or []
    parts = online[0] if online else []
    if len(parts) < 3 or not parts[0]:
        return ""
    y, m, d = parts[:3]
    return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"


def week_window(today=None):
    """Same 7 UTC dates as the client's utcDay(-6) … utcDay(0)."""
    hi = today or date.today()
    return (hi - timedelta(days=6)).isoformat(), hi.isoformat()


def get_soft(url, timeout=25):
    try:
        return get(url, tries=2, timeout=timeout)
    except Exception:  # noqa: BLE001
        return None


def crossref_journal_works(issn, lo, hi):
    items, offset = [], 0
    for _page in range(3):
        query = urllib.parse.urlencode({
            "filter": f"type:journal-article,from-online-pub-date:{lo},until-online-pub-date:{hi}",
            "rows": "100",
            "offset": str(offset),
            "select": "DOI,title,abstract,author,published-online,issued,volume,issue,page,license",
            "mailto": "robinmarie628@users.noreply.github.com",
        })
        data = get_soft(f"https://api.crossref.org/journals/{urllib.parse.quote(issn)}/works?{query}")
        batch = ((data or {}).get("message") or {}).get("items") or []
        items.extend(batch)
        total = ((data or {}).get("message") or {}).get("total-results") or 0
        offset += len(batch)
        if not batch or offset >= total or offset >= 300:
            break
    return items


def map_crossref_work(item, meta, lo, hi):
    title = clean((item.get("title") or [""])[0])
    doi = article_doi({"doi": item.get("DOI") or ""})
    day = crossref_day(item)
    if not title or not doi or not day or day < lo or day > hi:
        return None
    abstract = clean(item.get("abstract") or "")
    is_basic = bool(meta.get("basic"))
    study = detect_study(title, abstract, is_basic, [])
    authors = item.get("author") or []
    author0 = authors[0] if authors else {}
    name = " ".join(x for x in (author0.get("family"), author0.get("given")) if x) or author0.get("name") or ""
    return {
        "id": doi,
        "title": title,
        "abstract": abstract,
        "sections": None,
        "structured": False,
        "journal": meta.get("short") or "—",
        "issn": meta.get("issn") or "",
        "platforms": list(meta.get("platforms") or []),
        "domain": meta.get("domain") or "综合医学",
        "tier": meta.get("tier") or "specialty",
        "imp": meta.get("if", 0),
        "basic": is_basic,
        "studyKey": study,
        "studyZh": STUDY_ZH.get(study, "研究论文"),
        "studyRank": STUDY_RANK.get(study, 3),
        "stars": stars(meta.get("if", 0)),
        "date": day,
        "ts": 0,
        "year": day[:4],
        "authors": clean(name),
        "pmid": "",
        "doi": doi,
        "keywords": [],
        "volume": str(item.get("volume") or ""),
        "issue": str(item.get("issue") or ""),
        "pages": str(item.get("page") or ""),
        "oa": False,
    }


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _parent_map(root):
    parent = {}
    for node in root.iter():
        for child in list(node):
            parent[child] = node
    return parent


def _under_reference(node, parent):
    while node is not None:
        if _local(node.tag) == "ReferenceList":
            return True
        node = parent.get(node)
    return False


def parse_pubmed_article(art):
    parent = _parent_map(art)
    sections = {"objective": "", "methods": "", "results": "", "conclusion": "", "other": ""}
    chunks, mapped = [], False
    for node in art.iter():
        if _local(node.tag) != "AbstractText" or _under_reference(node, parent):
            continue
        label = (node.get("Label") or "").strip()
        text = clean("".join(node.itertext()))
        if not text:
            continue
        chunks.append(f"{label}: {text}" if label else text)
        key = section_key(label)
        if not key:
            continue
        if key != "other":
            mapped = True
        sections[key] = (sections[key] + " " + text).strip()
    structured = mapped and any(sections[k] for k in ("objective", "methods", "results", "conclusion"))
    doi = pmid = ""
    pub_types = []
    eloc = ""
    for node in art.iter():
        if _under_reference(node, parent):
            continue
        name = _local(node.tag)
        # The first article-level DOI. Later ArticleId nodes are cited papers;
        # keeping the last one files this abstract under someone else's DOI.
        if name == "ArticleId" and not doi and (node.get("IdType") or "").lower() == "doi":
            doi = article_doi({"doi": node.text or ""})
        elif name == "ELocationID" and not eloc and (node.get("EIdType") or "").lower() == "doi":
            eloc = article_doi({"doi": node.text or ""})
        elif name == "PMID" and not pmid and (node.get("Version") or "1") == "1":
            pmid = (node.text or "").strip()
        elif name == "PublicationType":
            label = clean("".join(node.itertext()))
            if label:
                pub_types.append(label)
    doi = doi or eloc
    return {
        "doi": doi,
        "pmid": pmid,
        "pubTypes": pub_types,
        "text": "\n".join(chunks),
        "structured": structured,
        "sections": sections if structured else None,
    }


def fill_pubmed_abstracts(articles):
    dois = []
    for a in articles:
        doi = article_doi(a)
        if doi and doi not in dois:
            dois.append(doi)
    pmids = []
    for i in range(0, len(dois), 40):
        chunk = dois[i:i + 40]
        term = " OR ".join(f"{d}[doi]" for d in chunk)
        query = urllib.parse.urlencode({
            "db": "pubmed", "retmode": "json", "retmax": "80", "term": term,
            "tool": "research-radar", "email": "robinmarie628@users.noreply.github.com",
        })
        data = get_soft(EUTILS + "esearch.fcgi?" + query, timeout=25)
        pmids.extend((((data or {}).get("esearchresult") or {}).get("idlist") or []))
        if i + 40 < len(dois):
            time.sleep(0.4)
    uniq, by_doi = [], {}
    for pmid in pmids:
        if pmid not in uniq:
            uniq.append(pmid)
    for i in range(0, len(uniq), 80):
        if i:
            time.sleep(0.4)
        query = urllib.parse.urlencode({
            "db": "pubmed", "id": ",".join(uniq[i:i + 80]), "retmode": "xml",
            "tool": "research-radar", "email": "robinmarie628@users.noreply.github.com",
        })
        try:
            req = urllib.request.Request(EUTILS + "efetch.fcgi?" + query, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                root = ET.fromstring(r.read())
        except Exception as e:  # noqa: BLE001
            print(f"      pubmed efetch skipped ({e})", file=sys.stderr)
            continue
        for art in root.iter():
            if _local(art.tag) != "PubmedArticle":
                continue
            hit = parse_pubmed_article(art)
            if hit["doi"]:
                by_doi[hit["doi"]] = hit
    for a in articles:
        hit = by_doi.get(article_doi(a))
        if not hit:
            continue
        if hit["pmid"]:
            a["pmid"] = hit["pmid"]
        text = (hit["text"] or "").strip()
        if len(text) < WEEK_ABS_MIN and abstract_len({
            "structured": hit["structured"], "sections": hit["sections"], "abstract": text,
        }) < WEEK_ABS_MIN:
            continue
        a["abstract"] = "" if hit["structured"] else text
        a["sections"] = hit["sections"]
        a["structured"] = bool(hit["structured"])
        blob = " ".join((hit["sections"] or {}).values()) if hit["structured"] else text
        study = detect_study(a.get("title") or "", blob, a.get("basic"), hit["pubTypes"])
        a["studyKey"] = study
        a["studyZh"] = STUDY_ZH.get(study, "研究论文")
        a["studyRank"] = STUDY_RANK.get(study, 3)


def _week_for_journal(meta, lo, hi):
    ids, found = [], []
    for issn in (meta.get("issn"), meta.get("essn")):
        if issn and issn not in ids:
            ids.append(issn)
    for issn in ids:
        works = crossref_journal_works(issn, lo, hi)
        for work in works:
            art = map_crossref_work(work, meta, lo, hi)
            if art:
                found.append(art)
        if works:
            break
    return found


def fetch_week_articles(cfg, today=None):
    """Crossref online dates for the last 7 days, abstracts from PubMed when needed.

    Mirrors assets/app.js fetchWeekArticles. A failure here returns [] so the
    shortlist falls back to the 15-day pool.
    """
    lo, hi = week_window(today)
    rows = [c for c in (cfg or []) if c and c.get("issn")]
    found = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        for batch in pool.map(lambda meta: _week_for_journal(meta, lo, hi), rows):
            found.extend(batch)
    by_doi = {}
    for art in found:
        by_doi.setdefault(art["doi"], art)
    articles = list(by_doi.values())
    if articles:
        fill_pubmed_abstracts(articles)
    kept = [a for a in articles if a.get("title") and abstract_len(a) >= WEEK_ABS_MIN]
    # Same order as assets/app.js fetchWeekArticles: newer online date first,
    # then title A→Z. Rank ties in 今日精选 keep this order, so the snapshot
    # hero matches the page when two papers share a tier and study type.
    kept.sort(key=lambda a: a.get("title") or "")
    kept.sort(key=lambda a: a.get("date") or "", reverse=True)
    print(f"      week {lo}..{hi}: {len(kept)} articles with abstracts ({len(articles)} online)")
    return kept


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


_MONTH = {name: i for i, name in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def norm_issn(value):
    """Canonical `NNNN-NNNX` so print and electronic forms compare."""
    raw = re.sub(r"[^0-9Xx]", "", str(value or "")).upper()
    if len(raw) != 8:
        return ""
    return raw[:4] + "-" + raw[4:]


def ymd_parts(year, month, day):
    if not year or not month or not day:
        return ""
    token = str(month).strip().lower()
    mi = int(token) if token.isdigit() else _MONTH.get(token[:3])
    try:
        yi, di = int(str(year).strip()), int(str(day).strip())
    except ValueError:
        return ""
    if not mi or mi < 1 or mi > 12 or di < 1 or di > 31 or yi < 1800:
        return ""
    return f"{yi:04d}-{mi:02d}-{di:02d}"


def date_from_pubmed_node(node):
    """A full calendar day from PubDate or ArticleDate, including MedlineDate."""
    if node is None:
        return ""
    parts = {_local(c.tag): (c.text or "").strip() for c in list(node)}
    day = ymd_parts(parts.get("Year"), parts.get("Month"), parts.get("Day"))
    if day:
        return day
    medline = parts.get("MedlineDate") or ""
    m = re.search(r"(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})(?:\s*[-/]\s*(\d{1,2}))?", medline)
    if not m:
        return ""
    return ymd_parts(m.group(1), m.group(2), m.group(4) or m.group(3))


def choose_pool_date(electronic, pub, lo, hi):
    """Date stored on the card. Must fall inside the same window as the query.

    Prefer the electronic day when PubMed has one inside the window. Lancet
    often goes online weeks earlier; the issue PubDate is what `[pdat]` uses
    to keep those trials inside the 15-day pool, so that day is the fallback.
    """
    if electronic and lo <= electronic <= hi:
        return electronic
    if pub and lo <= pub <= hi:
        return pub
    return ""


def is_junk_pubtypes(types):
    for label in types or []:
        if str(label).strip().lower() in JUNK_PUBTYPES:
            return True
    return False


def journal_indexes(cfg):
    """ISSN (print and electronic) and exact short/title → config row."""
    by_issn, by_name = {}, {}
    for c in cfg:
        for key in (c.get("issn"), c.get("essn")):
            n = norm_issn(key)
            if n:
                by_issn[n] = c
        for name in (c.get("short"), c.get("title")):
            k = (name or "").strip().lower()
            if k and k not in by_name:
                by_name[k] = c
    return by_issn, by_name


def match_pubmed_journal(issns, names, by_issn, by_name):
    """Join a PubMed record to one configured journal.

    Order: ISSNLinking or Journal/ISSN already in the config, then a known
    alias (PubMed's other ISSN for that title), then an exact ISO abbreviation
    or MedlineTA against `short` / `title`. Prefix matches are rejected so
    Lancet Oncology cannot land on Lancet.
    """
    norms = [norm_issn(v) for v in issns if norm_issn(v)]
    for issn in norms:
        hit = by_issn.get(issn)
        if hit:
            return hit, "issn"
    for issn in norms:
        alias = norm_issn(PUBMED_ISSN_ALIAS.get(issn, ""))
        hit = by_issn.get(alias) if alias else None
        if hit:
            return hit, "alias"
    for name in names:
        hit = by_name.get((name or "").strip().lower())
        if hit:
            return hit, "name"
    return None, ""


def check_pool_rules():
    """Guards for the date window, junk filter, and journal join."""
    lo, hi = "2026-10-04", "2026-10-19"
    assert choose_pool_date("2026-10-08", "2026-10-08", lo, hi) == "2026-10-08"
    assert choose_pool_date("2026-09-30", "2026-10-17", lo, hi) == "2026-10-17"
    assert choose_pool_date("2026-09-11", "2026-10-17", lo, hi) == "2026-10-17"
    assert choose_pool_date("2026-09-30", "2026-09-30", lo, hi) == ""
    assert choose_pool_date("", "2026-10-04", lo, hi) == "2026-10-04"
    assert ymd_parts("2026", "Oct", "17") == "2026-10-17"
    assert ymd_parts("2026", "10", "7") == "2026-10-07"
    assert is_junk_pubtypes(["Journal Article", "Letter"])
    assert is_junk_pubtypes(["Comment"])
    assert is_junk_pubtypes(["Editorial"])
    assert not is_junk_pubtypes(["Journal Article", "Review"])
    assert not is_junk_pubtypes(["Randomized Controlled Trial"])
    imaging = [{"issn": "1936-878X", "short": "JACC Imaging", "title": "JACC Imaging"}]
    by_issn, by_name = journal_indexes(imaging)
    meta, how = match_pubmed_journal(["1876-7591"], ["JACC Cardiovasc Imaging"], by_issn, by_name)
    assert meta and meta["issn"] == "1936-878X" and how == "alias", (meta, how)
    family = [
        {"issn": "0140-6736", "short": "Lancet", "title": "Lancet"},
        {"issn": "1470-2045", "short": "Lancet Oncol", "title": "Lancet Oncol"},
    ]
    by_issn, by_name = journal_indexes(family)
    meta, how = match_pubmed_journal(["1474-547X", "0140-6736"], ["Lancet"], by_issn, by_name)
    assert meta["short"] == "Lancet" and how == "issn"
    meta, how = match_pubmed_journal(["1470-2045"], ["Lancet Oncol"], by_issn, by_name)
    assert meta["short"] == "Lancet Oncol"
    meta, how = match_pubmed_journal(["1471-0000"], ["Lancet Oncology"], by_issn, by_name)
    assert meta is None and how == ""
    stem = [{"issn": "1934-5909", "short": "Cell Stem Cell", "title": "Cell Stem Cell"}]
    by_issn, by_name = journal_indexes(stem)
    meta, how = match_pubmed_journal(["1875-9777"], ["Cell Stem Cell"], by_issn, by_name)
    assert meta["short"] == "Cell Stem Cell" and how == "alias"
    meta, how = match_pubmed_journal([], ["Cell Stem Cell"], by_issn, by_name)
    assert how == "name"


def _kid(node, name):
    if node is None:
        return None
    for child in list(node):
        if _local(child.tag) == name:
            return child
    return None


def _kids(node, name):
    if node is None:
        return []
    return [child for child in list(node) if _local(child.tag) == name]


def _text(node):
    if node is None:
        return ""
    return "".join(node.itertext()).strip()


def pubmed_abstract(article):
    """Structured abstract from the article node only, same slots as the week parser."""
    sections = {"objective": "", "methods": "", "results": "", "conclusion": "", "other": ""}
    chunks, mapped = [], False
    abstract = _kid(article, "Abstract")
    for node in list(abstract) if abstract is not None else []:
        if _local(node.tag) != "AbstractText":
            continue
        label = (node.get("Label") or "").strip()
        text = clean("".join(node.itertext()))
        if not text:
            continue
        chunks.append(f"{label}: {text}" if label else text)
        key = section_key(label)
        if not key:
            continue
        if key != "other":
            mapped = True
        sections[key] = (sections[key] + " " + text).strip()
    structured = mapped and any(sections[k] for k in ("objective", "methods", "results", "conclusion"))
    plain = "\n".join(chunks).strip()
    length = abstract_len({
        "structured": structured,
        "sections": sections if structured else None,
        "abstract": plain,
    })
    blob = " ".join(v for v in sections.values() if v) if structured else plain
    return {
        "text": plain,
        "structured": structured,
        "sections": sections if structured else None,
        "length": length,
        "blob": blob,
    }


def pubmed_author(article):
    authors = _kid(article, "AuthorList")
    for node in list(authors) if authors is not None else []:
        if _local(node.tag) != "Author":
            continue
        last = clean(_text(_kid(node, "LastName")))
        ini = clean(_text(_kid(node, "Initials")))
        if last and ini:
            return f"{last} {ini}"
        if last:
            return last
        collective = clean(_text(_kid(node, "CollectiveName")))
        if collective:
            return collective
    return ""


def pubmed_keywords(med):
    out = []
    for node in list(med) if med is not None else []:
        if _local(node.tag) != "KeywordList":
            continue
        for kw in list(node):
            if _local(kw.tag) != "Keyword":
                continue
            text = clean(_text(kw))
            if text:
                out.append(text)
    return out


def map_pubmed_article(art, by_issn, by_name, lo, hi):
    """One PubmedArticle → pool card, or (None, reason)."""
    med = _kid(art, "MedlineCitation")
    article = _kid(med, "Article")
    if article is None:
        return None, "shape"
    journal = _kid(article, "Journal")
    info = _kid(med, "MedlineJournalInfo")
    issns = []
    linking = norm_issn(_text(_kid(info, "ISSNLinking")))
    if linking:
        issns.append(linking)
    for node in _kids(journal, "ISSN"):
        n = norm_issn(node.text or "")
        if n and n not in issns:
            issns.append(n)
    iso = _text(_kid(journal, "ISOAbbreviation"))
    ta = _text(_kid(info, "MedlineTA"))
    meta, how = match_pubmed_journal(issns, [iso, ta], by_issn, by_name)
    if not meta:
        return None, "unmatched"
    pubtypes = [_text(n) for n in _kids(_kid(article, "PublicationTypeList"), "PublicationType")]
    pubtypes = [t for t in pubtypes if t]
    if is_junk_pubtypes(pubtypes):
        return None, "junk"
    parsed = pubmed_abstract(article)
    if parsed["length"] < WEEK_ABS_MIN:
        return None, "abstract"
    title = clean(_text(_kid(article, "ArticleTitle")))
    if not title:
        return None, "title"
    issue = _kid(journal, "JournalIssue")
    pub = date_from_pubmed_node(_kid(issue, "PubDate"))
    electronic = ""
    for node in _kids(article, "ArticleDate"):
        if (node.get("DateType") or "") == "Electronic":
            electronic = date_from_pubmed_node(node) or electronic
    day = choose_pool_date(electronic, pub, lo, hi)
    if not day:
        return None, "date"
    doi = ""
    pmc = False
    for node in _kids(_kid(_kid(art, "PubmedData"), "ArticleIdList"), "ArticleId"):
        kind = (node.get("IdType") or "").lower()
        if kind == "doi" and not doi:
            doi = article_doi({"doi": node.text or ""})
        elif kind == "pmc" and (node.text or "").strip():
            pmc = True
    if not doi:
        for node in _kids(article, "ELocationID"):
            if (node.get("EIdType") or "").lower() == "doi":
                doi = article_doi({"doi": node.text or ""})
                if doi:
                    break
    pmid = _text(_kid(med, "PMID"))
    ident = doi or pmid.lower()
    if not ident:
        return None, "id"
    is_basic = bool(meta.get("basic"))
    study = detect_study(title, parsed["blob"], is_basic, pubtypes)
    return {
        "id": ident,
        "title": title,
        "abstract": "" if parsed["structured"] else parsed["text"],
        "sections": parsed["sections"],
        "structured": parsed["structured"],
        "journal": meta.get("short") or iso or "—",
        "issn": meta.get("issn") or "",
        "platforms": list(meta.get("platforms") or []),
        "domain": meta.get("domain") or "综合医学",
        "tier": meta.get("tier") or "specialty",
        "imp": meta.get("if", 0),
        "basic": is_basic,
        "studyKey": study,
        "studyZh": STUDY_ZH.get(study, "研究论文"),
        "studyRank": STUDY_RANK.get(study, 3),
        "stars": stars(meta.get("if", 0)),
        "date": day,
        "ts": 0,
        "year": day[:4],
        "authors": pubmed_author(article),
        "pmid": pmid,
        "doi": doi,
        "keywords": pubmed_keywords(med),
        "volume": _text(_kid(issue, "Volume")),
        "issue": _text(_kid(issue, "Issue")),
        "pages": _text(_kid(_kid(article, "Pagination"), "MedlinePgn")),
        "oa": pmc,
    }, how


def get_text(url, tries=4, timeout=90):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 + i * 2)
    raise RuntimeError(f"{url[:90]} -> {last}")


def pubmed_window_term(cfg, lo, hi):
    issns = []
    for c in cfg:
        for key in (c.get("issn"), c.get("essn")):
            n = norm_issn(key)
            if n and n not in issns:
                issns.append(n)
    if not issns:
        return ""
    joined = " OR ".join(f"{i}[issn]" for i in issns)
    junk = " OR ".join([
        "letter[pt]", "editorial[pt]", "comment[pt]", "news[pt]", "interview[pt]",
        '"published erratum"[pt]', "erratum[pt]",
        '"retraction of publication"[pt]', '"retracted publication"[pt]',
    ])
    return (f"({joined}) AND {lo.replace('-', '/')}:{hi.replace('-', '/')}[pdat]"
            f" AND hasabstract NOT ({junk})")


def esearch_pmids(term):
    ids, retstart, count = [], 0, None
    while count is None or retstart < count:
        query = urllib.parse.urlencode({
            "db": "pubmed", "retmode": "json", "retmax": "500",
            "retstart": str(retstart), "term": term, "sort": "pub_date",
            "tool": "research-radar",
            "email": "robinmarie628@users.noreply.github.com",
        })
        data = json.loads(get_text(EUTILS + "esearch.fcgi?" + query).decode("utf-8"))
        res = data.get("esearchresult") or {}
        if res.get("ERROR"):
            raise RuntimeError(res.get("ERROR"))
        count = int(res.get("count") or 0)
        batch = res.get("idlist") or []
        ids.extend(batch)
        if not batch:
            break
        retstart += len(batch)
        if retstart < count:
            time.sleep(0.34)
    seen, out = set(), []
    for pmid in ids:
        if pmid not in seen:
            seen.add(pmid)
            out.append(pmid)
    return out


def efetch_pubmed(pmids):
    articles = []
    for i in range(0, len(pmids), 120):
        if i:
            time.sleep(0.34)
        query = urllib.parse.urlencode({
            "db": "pubmed", "id": ",".join(pmids[i:i + 120]), "retmode": "xml",
            "tool": "research-radar",
            "email": "robinmarie628@users.noreply.github.com",
        })
        root = ET.fromstring(get_text(EUTILS + "efetch.fcgi?" + query))
        for node in list(root):
            if _local(node.tag) == "PubmedArticle":
                articles.append(node)
    return articles


def fetch_pubmed_candidates(cfg, lo, hi):
    """Every configured journal, one PubMed window, abstracts required.

    Caps are applied later by compose_pool. Fetching the window (instead of
    stopping at FLAGSHIP_CAP inside the query) lets a thin flagship such as
    Lancet keep every abstract it actually has, up to that cap.
    """
    term = pubmed_window_term(cfg, lo, hi)
    pmids = esearch_pmids(term)
    print(f"      pubmed {lo}..{hi}: {len(pmids)} ids with abstracts")
    articles = efetch_pubmed(pmids)
    by_issn, by_name = journal_indexes(cfg)
    cands, seen, stats = [], set(), {}
    for art in articles:
        item, how = map_pubmed_article(art, by_issn, by_name, lo, hi)
        stats[how] = stats.get(how, 0) + 1
        if not item:
            continue
        if item["id"] in seen:
            stats["dup"] = stats.get("dup", 0) + 1
            continue
        seen.add(item["id"])
        cands.append(item)
    print(f"      pubmed kept {len(cands)} before caps {stats}")
    return cands


def fetch_epmc_candidates(cfg, by_issn, lo, hi):
    """Previous Europe PMC pool. Only used when PubMed is down or empty."""
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
    return cands, len(merged)


def build_journals(days, cap_per_journal=8):
    """PubMed abstracts for every configured journal, then the same compose_pool.

    `cap_per_journal` is unused; caps come from TIER_CAP inside compose_pool.
    Europe PMC remains a fallback for a PubMed outage, not a second source
    mixed into a successful PubMed window. 最近一周 is unchanged.
    """
    cfg = json.load(open(os.path.join(DATA, "journals.config.json"), encoding="utf-8"))
    by_issn = index_journals(cfg)
    hi = date.today().isoformat()
    lo = (date.today() - timedelta(days=days)).isoformat()

    source = "pubmed"
    try:
        cands = fetch_pubmed_candidates(cfg, lo, hi)
        raw = len(cands)
    except Exception as e:  # noqa: BLE001
        print(f"      pubmed pool failed ({e}); falling back to Europe PMC", file=sys.stderr)
        cands, raw = [], 0
        source = "europepmc"
    if source == "pubmed" and not cands:
        print("      pubmed pool empty; falling back to Europe PMC", file=sys.stderr)
        source = "europepmc"
    if source == "europepmc":
        cands, raw = fetch_epmc_candidates(cfg, by_issn, lo, hi)

    items = compose_pool(cands)
    week = []
    try:
        week = fetch_week_articles(cfg)
    except Exception as e:  # noqa: BLE001
        print(f"      week fetch failed ({e}); picks fall back to the 15-day pool", file=sys.stderr)

    return {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "windowDays": days, "journals": len(cfg), "rawFetched": raw,
            "source": source,
            "updated": items[0]["date"] if items else None,
            "picks": select_picks(week, items),
            "week": week,
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
    check_pool_rules()

    print(f"[1/2] journals (last {a.days}d) ...")
    jr = build_journals(a.days)
    week_n = len(jr.pop("week", []) or [])
    json.dump(jr, open(os.path.join(DATA, "snapshot-journals.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"      week candidates used for picks: {week_n}")
    from collections import Counter
    print(f"      source {jr.get('source')}  {len(jr['items'])} articles"
          f" (raw {jr['rawFetched']}), newest {jr['updated']}")
    print(f"      领域: {dict(Counter(x['domain'] for x in jr['items']))}")
    print(f"      类型: {dict(Counter(x['studyZh'] for x in jr['items']))}")
    print(f"      临床 {sum(1 for x in jr['items'] if not x['basic'])} / 基础 {sum(1 for x in jr['items'] if x['basic'])}"
          f"  | 结构化摘要 {sum(1 for x in jr['items'] if x['structured'])}")
    print(f"      今日精选 {len(jr['picks'])} 篇 (基础 {sum(1 for p in jr['picks'] if p['basic'])})")
    focus = ("Lancet", "Nature", "NEJM", "Science", "BMJ", "Cell")
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
