#!/usr/bin/env python3
"""Validate candidate journal ISSNs against Europe PMC.

Every ISSN is probed with a real query; anything returning 0 hits over a wide
90-day window is flagged (wrong ISSN / dead journal). Outputs the validated
config to data/journals.config.json.

stdlib only.  Usage:  python validate_issns.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
UA = "research-radar/1.0 (mailto:robinmarie628@users.noreply.github.com)"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "journals.config.json")

# (issn, full title, short label, approx impact factor, direction group)
# IF values are the 2024 JCR release, rounded - used only for a 1-5 star tier.
CANDIDATES = [
    # --- 综合顶刊 top general ---
    ("0028-4793", "New England Journal of Medicine", "NEJM", 96.2, "top"),
    ("0140-6736", "The Lancet", "Lancet", 98.4, "top"),
    ("0098-7484", "JAMA", "JAMA", 63.1, "top"),
    ("0959-8138", "BMJ", "BMJ", 93.6, "top"),
    ("1078-8956", "Nature Medicine", "Nat Med", 58.7, "top"),
    # --- 心血管疾病 cardiovascular ---
    ("0009-7322", "Circulation", "Circulation", 35.5, "cvd"),
    ("0195-668X", "European Heart Journal", "Eur Heart J", 37.6, "cvd"),
    ("0735-1097", "Journal of the American College of Cardiology", "JACC", 21.7, "cvd"),
    ("1936-8798", "JACC: Cardiovascular Interventions", "JACC Interv", 11.7, "cvd"),
    ("1936-878X", "JACC: Cardiovascular Imaging", "JACC Imaging", 10.9, "cvd"),
    ("2405-5018", "JACC: Clinical Electrophysiology", "JACC EP", 4.0, "cvd"),
    ("0009-7330", "Circulation Research", "Circ Res", 16.5, "cvd"),
    ("1355-6037", "Heart", "Heart", 5.7, "cvd"),
    ("0002-8703", "American Heart Journal", "Am Heart J", 4.3, "cvd"),
    ("1941-7640", "Circulation: Cardiovascular Interventions", "Circ Interv", 6.7, "cvd"),
    ("2047-9980", "Journal of the American Heart Association", "JAHA", 5.0, "cvd"),
    ("1759-5002", "Nature Reviews Cardiology", "Nat Rev Cardiol", 41.7, "cvd"),
    ("2047-2404", "European Heart Journal - Cardiovascular Imaging", "EHJ Imaging", 6.2, "cvd"),
    ("1099-5129", "Europace", "Europace", 6.1, "cvd"),
    ("1774-024X", "EuroIntervention", "EuroIntervention", 7.6, "cvd"),
    ("1524-4539", "Circulation. Cardiovascular quality and outcomes", "Circ QO", 6.2, "cvd"),
    # --- 心力衰竭 heart failure ---
    ("2213-1779", "JACC: Heart Failure", "JACC HF", 10.4, "hf"),
    ("1388-9842", "European Journal of Heart Failure", "Eur J Heart Fail", 16.9, "hf"),
    ("1941-3289", "Circulation: Heart Failure", "Circ HF", 7.9, "hf"),
    ("1053-2498", "Journal of Heart and Lung Transplantation", "JHLT", 6.4, "hf"),
    # --- 高血压 hypertension ---
    ("0194-911X", "Hypertension", "Hypertension", 6.9, "htn"),
    ("0263-6352", "Journal of Hypertension", "J Hypertens", 3.3, "htn"),
    ("1524-4563", "Hypertension (Dallas, Tex. : 1979)", "Hypertension", 6.9, "htn"),
    # --- 主动脉夹层 aortic / vascular ---
    ("0741-5214", "Journal of Vascular Surgery", "J Vasc Surg", 3.9, "aortic"),
    ("1078-5884", "European Journal of Vascular and Endovascular Surgery", "EJVES", 5.7, "aortic"),
    ("1010-7940", "European Journal of Cardio-Thoracic Surgery", "EJCTS", 3.4, "aortic"),
    ("0022-5223", "Journal of Thoracic and Cardiovascular Surgery", "JTCVS", 4.9, "aortic"),
    ("0003-4975", "Annals of Thoracic Surgery", "Ann Thorac Surg", 3.6, "aortic"),
    # --- 肺动脉高压 pulmonary hypertension ---
    ("2045-8932", "Pulmonary Circulation", "Pulm Circ", 2.4, "ph"),
    # --- 重症医学 critical care ---
    ("0342-4642", "Intensive Care Medicine", "Intensive Care Med", 27.1, "icu"),
    ("0090-3493", "Critical Care Medicine", "Crit Care Med", 7.7, "icu"),
    ("1364-8535", "Critical Care", "Crit Care", 8.8, "icu"),
    ("1073-449X", "American Journal of Respiratory and Critical Care Medicine", "AJRCCM", 19.3, "icu"),
    ("0012-3692", "CHEST", "Chest", 9.5, "icu"),
    ("2110-5820", "Annals of Intensive Care", "Ann Intensive Care", 5.7, "icu"),
    ("1073-2322", "Shock", "Shock", 2.6, "icu"),
    ("2052-0492", "Journal of Intensive Care", "J Intensive Care", 3.5, "icu"),
    ("0883-9441", "Journal of Critical Care", "J Crit Care", 3.2, "icu"),
    ("0300-9572", "Resuscitation", "Resuscitation", 6.5, "icu"),
    ("2329-6933", "Annals of the American Thoracic Society", "Ann Am Thorac Soc", 4.4, "icu"),
    ("2213-2600", "Lancet Respiratory Medicine", "Lancet Respir Med", 38.7, "icu"),
    ("0903-1936", "European Respiratory Journal", "Eur Respir J", 16.6, "icu"),
    ("0040-6376", "Thorax", "Thorax", 9.0, "icu"),
    ("1535-4970", "Intensive Care Medicine Experimental", "ICM Exp", 3.0, "icu"),
]


def epmc_count(issn, lo, hi, tries=4):
    q = f'ISSN:"{issn}" AND SRC:MED AND FIRST_PDATE:[{lo} TO {hi}]'
    url = EPMC + "?" + urllib.parse.urlencode(
        {"query": q, "format": "json", "pageSize": 1}
    )
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8")).get("hitCount", 0)
        except Exception as e:  # noqa: BLE001 - transient 503s are expected
            last = e
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f"{issn}: {last}")


def main():
    hi = date.today().isoformat()
    lo = (date.today() - timedelta(days=90)).isoformat()
    print(f"Validating {len(CANDIDATES)} ISSNs over {lo} .. {hi}\n")

    good, bad = [], []
    for issn, title, short, imp, grp in CANDIDATES:
        try:
            n = epmc_count(issn, lo, hi)
        except Exception as e:  # noqa: BLE001
            print(f"  ERR  {issn}  {short:<18} {e}")
            bad.append((issn, title, "network"))
            continue
        flag = "OK " if n > 0 else "DEAD"
        if n == 0:
            bad.append((issn, title, "0 hits"))
        print(f"  {flag} {issn}  {short:<18} {n:>4} articles / 90d")
        if n > 0:
            good.append(
                {
                    "issn": issn,
                    "title": title,
                    "short": short,
                    "if": imp,
                    "group": grp,
                    "n90": n,
                }
            )
        time.sleep(0.35)

    # de-duplicate by ISSN, then by short label (the two Hypertension entries)
    seen_issn, seen_short, final = set(), set(), []
    for j in good:
        if j["issn"] in seen_issn or j["short"] in seen_short:
            continue
        seen_issn.add(j["issn"])
        seen_short.add(j["short"])
        final.append(j)

    print(f"\nvalid: {len(final)}   rejected: {len(bad)}")
    for b in bad:
        print("   rejected:", b)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(final, f, ensure_ascii=False, indent=2)
    print(f"\nwrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    sys.exit(main())
