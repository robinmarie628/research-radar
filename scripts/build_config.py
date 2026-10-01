#!/usr/bin/env python3
"""Validate the journal pool and emit data/journals.config.json.

Pool = 40 clinical top journals + 18 CNS / basic-science journals, per
daily_journal_watch_prompt.md. Each ISSN is probed against Europe PMC; anything
returning 0 hits over 90 days is rejected (a wrong ISSN fails silently as 0 rows).

Also samples recent abstracts per journal so the section parser can be built
against real heading vocabularies rather than guesswork.

stdlib only.  Usage:  python build_config.py [--sample]
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
UA = "research-radar/1.0 (mailto:robinmarie628@users.noreply.github.com)"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

# issn -> (领域 domain, 基础/分子 basic, short label, approx 2024 JCR IF)
POOL = {
    # ── 40 本临床顶刊 ────────────────────────────────────────────────
    "0140-6736": ("综合医学",   False, "Lancet",             98.4),
    "1470-2045": ("肿瘤",       False, "Lancet Oncol",       41.6),
    "1474-4422": ("神经",       False, "Lancet Neurol",       46.5),
    "1473-3099": ("感染",       False, "Lancet Infect Dis",   36.4),
    "2213-2600": ("呼吸与重症", False, "Lancet Respir Med",   38.7),
    "2213-8587": ("内分泌代谢", False, "Lancet Diabetes Endo",44.0),
    "2468-1253": ("消化肝病",   False, "Lancet Gastro Hepat", 30.9),
    "2352-3026": ("血液",       False, "Lancet Haematol",     24.7),
    "2215-0366": ("精神心理",   False, "Lancet Psychiatry",   30.8),
    "2468-2667": ("公共卫生",   False, "Lancet Public Health",25.4),
    "2214-109X": ("全球健康",   False, "Lancet Glob Health",  19.9),
    "2589-7500": ("数字医疗",   False, "Lancet Digit Health", 23.8),
    "2352-4642": ("儿科",       False, "Lancet Child Adolesc",19.9),
    "2665-9913": ("风湿免疫",   False, "Lancet Rheumatol",    15.0),
    "2352-3018": ("感染",       False, "Lancet HIV",          12.8),
    "2666-5247": ("感染",       False, "Lancet Microbe",      20.9),
    "2589-5370": ("综合医学",   False, "EClinicalMedicine",    9.6),
    "2542-5196": ("公共卫生",   False, "Lancet Planet Health",24.1),
    "2666-7568": ("老年医学",   False, "Lancet Healthy Longev",13.1),
    "0735-1097": ("心血管",     False, "JACC",                21.7),
    "1936-8798": ("心血管",     False, "JACC Interv",         11.7),
    "2213-1779": ("心血管",     False, "JACC Heart Fail",     10.4),
    "1936-878X": ("心血管",     False, "JACC Imaging",        10.9),
    "2405-5018": ("心血管",     False, "JACC Clin EP",         4.0),
    "2452-302X": ("基础医学",   True,  "JACC Basic Transl",    8.0),
    "2666-0873": ("肿瘤",       False, "JACC CardioOncol",    10.0),
    "2772-963X": ("心血管",     False, "JACC Adv",             3.0),
    "0012-3692": ("呼吸与重症", False, "Chest",                9.5),
    # NOTE: the prompt lists CHEST Pulmonary (2949-7884) and CHEST Critical Care (2949-7892);
    # both are too new for MEDLINE and return 0 hits from Europe PMC, so they are omitted.
    "0161-6420": ("眼科",       False, "Ophthalmology",       13.1),
    "2468-6530": ("眼科",       False, "Ophthalmol Retina",    5.9),
    "2589-4196": ("眼科",       False, "Ophthalmol Glaucoma",  3.5),
    "2666-9145": ("眼科",       False, "Ophthalmol Sci",       4.2),
    "0002-9394": ("眼科",       False, "Am J Ophthalmol",      4.1),
    "0923-7534": ("肿瘤",       False, "Ann Oncol",           56.7),
    "0168-8278": ("消化肝病",   False, "J Hepatol",           26.8),
    "0085-2538": ("肾脏",       False, "Kidney Int",          14.8),
    "0190-9622": ("皮肤",       False, "JAAD",                12.8),
    "0302-2838": ("泌尿",       False, "Eur Urol",            25.3),
    # ── 18 本基础 / 分子医学（CNS 及其生物医学子刊）──────────────────
    "0092-8674": ("基础医学",   True,  "Cell",                45.5),
    "0028-0836": ("基础医学",   True,  "Nature",              50.5),
    "0036-8075": ("基础医学",   True,  "Science",             44.7),
    "0028-4793": ("综合医学",   False, "NEJM",                96.2),  # 临床，但列在 CNS 段
    "1061-4036": ("基础医学",   True,  "Nat Genet",           31.7),
    "1529-2908": ("基础医学",   True,  "Nat Immunol",         27.7),
    "1934-5909": ("基础医学",   True,  "Cell Stem Cell",      19.8),
    "1946-6234": ("基础医学",   True,  "Sci Transl Med",      15.8),
    "2375-2548": ("基础医学",   True,  "Sci Adv",             11.7),
    "2041-1723": ("基础医学",   True,  "Nat Commun",          14.7),
    "2211-1247": ("基础医学",   True,  "Cell Rep",             7.5),
    "1553-7358": ("基础医学",   True,  "Cell Host Microbe",   20.6),
    "2405-4712": ("基础医学",   True,  "Cell Syst",            9.0),
    "2157-846X": ("基础医学",   True,  "Nat Biomed Eng",      26.8),  # 2372-7705 is not indexed
    "1087-0156": ("基础医学",   True,  "Nat Biotechnol",      33.1),
    "1097-6256": ("神经",       True,  "Nat Neurosci",        21.2),
    "0896-6273": ("神经",       True,  "Neuron",              14.7),
}

# mirrors BASIC_FRAGMENTS in the prompt doc: basic is decided by journal NAME
BASIC_FRAGMENTS = ("Cell", "Nature", "Science", "Neuron", "JACC: Basic")


def get(url, tries=4, timeout=45):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 + i * 2)
    raise RuntimeError(f"{url[:80]} -> {last}")


def probe(issn, lo, hi):
    """Return (hit_count, journal_title)."""
    q = f'ISSN:"{issn}" AND SRC:MED AND FIRST_PDATE:[{lo} TO {hi}]'
    u = EPMC + "?" + urllib.parse.urlencode(
        {"query": q, "format": "json", "pageSize": 1})
    d = get(u)
    hits = d.get("hitCount", 0)
    title = ""
    res = d.get("resultList", {}).get("result", [])
    if res:
        title = (res[0].get("journalInfo", {}).get("journal", {}) or {}).get("title", "")
    return hits, title


def sample_headings(issn, lo, hi, n=6):
    q = f'ISSN:"{issn}" AND SRC:MED AND HAS_ABSTRACT:Y AND FIRST_PDATE:[{lo} TO {hi}]'
    u = EPMC + "?" + urllib.parse.urlencode(
        {"query": q, "format": "json", "pageSize": n, "resultType": "core",
         "sort": "P_PDATE_D desc"})
    heads, ptypes = [], set()
    try:
        for r in get(u).get("resultList", {}).get("result", []):
            ab = r.get("abstractText") or ""
            heads += [m[1].strip() for m in
                      re.findall(r"<(h4|h3|b|strong|i)>([^<]{2,44})</\1>", ab)]
            ptypes.update(r.get("pubTypeList", {}).get("pubType", []) or [])
    except Exception as e:  # noqa: BLE001
        print(f"      sample failed: {e}", file=sys.stderr)
    return heads, sorted(ptypes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="also sample abstract headings")
    a = ap.parse_args()

    hi = date.today().isoformat()
    lo90 = (date.today() - timedelta(days=90)).isoformat()
    lo30 = (date.today() - timedelta(days=30)).isoformat()

    print(f"Validating {len(POOL)} ISSNs over {lo90} .. {hi}\n")
    cfg, bad, all_heads = [], [], []

    for issn, (domain, basic, short, imp) in POOL.items():
        try:
            hits, title = probe(issn, lo90, hi)
        except Exception as e:  # noqa: BLE001
            print(f"  ERR  {issn} {short:<22} {e}")
            bad.append((issn, short, "network"))
            continue

        flag = "OK " if hits > 0 else "DEAD"
        print(f"  {flag} {issn}  {short:<22} {hits:>4} /90d   {title[:44]}")
        if hits == 0:
            bad.append((issn, short, "0 hits"))
            continue

        # basic flag must agree with the doc's name-fragment rule
        by_name = any(f in title for f in BASIC_FRAGMENTS) or basic
        cfg.append({"issn": issn, "title": title or short, "short": short,
                    "domain": domain, "basic": bool(by_name), "if": imp, "n90": hits})

        if a.sample:
            hs, pts = sample_headings(issn, lo30, hi)
            all_heads += hs
            if hs:
                print(f"        headings: {sorted(set(hs))}")
            print(f"        pubTypes: {pts}")
            time.sleep(0.3)
        time.sleep(0.3)

    print(f"\nvalid: {len(cfg)}   rejected: {len(bad)}")
    for b in bad:
        print("   rejected:", b)
    print("basic-tagged:", sum(1 for c in cfg if c["basic"]),
          " clinical:", sum(1 for c in cfg if not c["basic"]))

    out = os.path.join(DATA, "journals.config.json")
    json.dump(cfg, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\nwrote {os.path.abspath(out)}")

    if a.sample and all_heads:
        from collections import Counter
        print("\n--- abstract heading vocabulary (top 45) ---")
        for h, n in Counter(all_heads).most_common(45):
            print(f"  {n:>4}  {h}")


if __name__ == "__main__":
    sys.exit(main())
