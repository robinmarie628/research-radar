#!/usr/bin/env python3
"""Build the fallback snapshots for 科研雷达.

The web app fetches live data on open; these snapshots are the offline / API-down
safety net and the payload the optional GitHub Action refreshes daily.

Writes:
  data/snapshot-journals.json   Europe PMC articles (classified)
  data/snapshot-builders.json   follow-builders X / blog / podcast items

stdlib only.  Usage:  python build_snapshot.py [--days 14]
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

# --- mirrors the classifier in assets/app.js -------------------------------
DIRS = [
    ("ph", "肺动脉高压",
     r"pulmonary (arterial )?hypertension|pulmonary vascular resistance|pulmonary artery pressure"
     r"|precapillary|pulmonary endarterectomy|right ventricular (failure|dysfunction)"),
    ("aortic", "主动脉夹层",
     r"aortic dissection|aortic aneurysm|thoracic aortic|aortic root|aortopathy|tevar|evar"
     r"|endovascular (aneurysm|aortic|repair)|type [ab] (aortic )?dissection|abdominal aortic"
     r"|aortic (stent|repair)"),
    ("hf", "心力衰竭",
     r"heart failure|hfpef|hfref|hfmref|cardiac failure|ventricular assist|lvad|ejection fraction"
     r"|cardiac resynchroni|myocardial recovery|pulmonary oedema|pulmonary edema"),
    ("htn", "高血压",
     r"hypertension|blood pressure|antihypertensive|hypertensive|resistant hypertension"
     r"|aldosterone|renin-angiotensin"),
    ("icu", "重症医学",
     r"sepsis|septic shock|critically ill|intensive care|mechanical ventilation"
     r"|acute respiratory distress|\bards\b|extracorporeal|\becmo\b|vasopressor|delirium"
     r"|acute kidney injury|organ (dys)?function|resuscitation|cardiac arrest|sedation|weaning"
     r"|prone position"),
    ("cvd", "心血管疾病",
     r"coronary|myocardial infarction|percutaneous coronary|atrial fibrillation|valve|tavr|tavi"
     r"|stent|atherosclerosis|arrhythmi|stroke|cardiac surgery|cabg|thrombectomy|transcatheter"
     r"|cardiovascular|lipid|statin|cardiac magnetic"),
]
DIR_RE = {k: re.compile(p, re.I) for k, _, p in DIRS}
DIR_ZH = {k: zh for k, zh, _ in DIRS}
GROUP_ZH = {"top": "cvd", "cvd": "cvd", "hf": "hf", "htn": "htn",
            "aortic": "aortic", "ph": "ph", "icu": "icu"}
TAG_RE = re.compile(r"<[^>]*>")
ENT = [("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&apos;", "'"),
       ("&nbsp;", " "), ("&amp;", "&")]


def clean(s):
    """Decode entities FIRST, then strip tags.

    Order matters: Europe PMC double-encodes markup, so a tag-strip before entity
    decoding leaves `&lt;sup&gt;` behind, which then becomes a literal `<sup>`.
    """
    if not s:
        return ""
    s = str(s)
    for _ in range(2):                      # handles double-encoded markup
        for a, b in ENT:
            s = s.replace(a, b)
        s = TAG_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def classify(title, abstract, group):
    """Return (direction_key, score). score == 0 means nothing matched."""
    t, a = title or "", abstract or ""
    best, best_score = None, 0
    for key, _zh, _p in DIRS:
        rx = DIR_RE[key]
        score = len(rx.findall(t)) * 3 + min(len(rx.findall(a)), 6)
        if score > best_score:
            best, best_score = key, score
    return best, best_score


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


def build_journals(days, cap_per_journal=8):
    """Query Europe PMC in chunks, merge, then cap per journal.

    A single query lets one high-volume journal (JAHA publishes ~33 items/fortnight)
    crowd out every top-tier title, so we split the ISSN list and rebalance.
    """
    cfg = json.load(open(os.path.join(DATA, "journals.config.json"), encoding="utf-8"))
    by_issn = {c["issn"]: c for c in cfg}

    hi = date.today().isoformat()
    lo = (date.today() - timedelta(days=days)).isoformat()

    # split into 3 chunks -> up to 300 raw records to rebalance from
    n = len(cfg)
    step = (n + 2) // 3
    chunks = [cfg[i:i + step] for i in range(0, n, step)]

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

    # 1) map + classify + filter, 2) sort by date, 3) cap per journal.
    # The cap must come AFTER filtering, otherwise a general journal's off-topic
    # articles consume its quota and the on-topic ones get dropped.
    cands = []
    for r in merged:
        ji = r.get("journalInfo", {}) or {}
        j = ji.get("journal", {}) or {}
        issn = j.get("issn") or j.get("essn") or ""
        meta = by_issn.get(issn, {})
        title = clean(r.get("title"))
        if not title:
            continue
        abstract = clean(r.get("abstractText"))
        grp = meta.get("group", "cvd")
        key, score = classify(title, abstract, grp)

        # General medical journals (NEJM / Lancet / JAMA / BMJ / Nat Med) publish far
        # beyond cardiology. Keep only articles that actually match a direction.
        if grp == "top" and score == 0:
            continue
        if not key:
            key = GROUP_ZH.get(grp, "cvd")

        d = r.get("firstPublicationDate") or r.get("electronicPublicationDate") or ""
        imp = meta.get("if", 0)
        cands.append({
            "id": r.get("doi") or r.get("id") or r.get("pmid"),
            "title": title,
            "abstract": abstract,
            "journal": meta.get("short") or j.get("medlineAbbreviation") or "—",
            "imp": imp, "group": grp,
            "dir": key, "dirZh": DIR_ZH[key],
            "stars": stars(imp),
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
    ap.add_argument("--days", type=int, default=14)
    a = ap.parse_args()

    print(f"[1/2] journals (last {a.days}d) ...")
    jr = build_journals(a.days)
    json.dump(jr, open(os.path.join(DATA, "snapshot-journals.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"      {len(jr['items'])} articles, newest {jr['updated']}")

    print("[2/2] builders ...")
    bd = build_builders()
    json.dump(bd, open(os.path.join(DATA, "snapshot-builders.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"      {len(bd['items'])} posts, feed generatedAt {bd['generatedAt']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
