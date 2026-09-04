#!/usr/bin/env python3
"""Consolidate every run under results/cloud/ into one JSON the writeup is
built from. Nothing in the blog should be typed by hand -- if a number is not
in here, it is not in a run, and it does not go in the document.

    python lab/analyze.py            # table to stdout
    python lab/analyze.py --json     # machine-readable, for the charts
"""
import csv
import io
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CLOUD = os.path.join(ROOT, "results", "cloud")


def read_json(path):
    try:
        with io.open(path, encoding="utf-8-sig") as fh:
            return json.load(fh)
    except Exception:
        return None


def metric(summary, name, stat):
    m = (summary or {}).get("metrics", {}).get(name)
    if not m:
        return None
    return (m.get("values") or m).get(stat)


def read_samples(path):
    """Peak and mean of each sampled column, ignoring blanks."""
    if not os.path.exists(path):
        return {}
    cols = {}
    with io.open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            for k, v in row.items():
                if k is None or v in (None, ""):
                    continue
                try:
                    cols.setdefault(k, []).append(float(v))
                except ValueError:
                    pass
    out = {}
    for k, vals in cols.items():
        if not vals:
            continue
        out[k] = {"peak": max(vals), "mean": round(sum(vals) / len(vals), 2),
                  "last": vals[-1], "n": len(vals)}
    return out


def collect():
    runs = []
    if not os.path.isdir(CLOUD):
        return runs
    for tag in sorted(os.listdir(CLOUD)):
        d = os.path.join(CLOUD, tag)
        if not os.path.isdir(d):
            continue
        s = read_json(os.path.join(d, "summary.json"))
        meta = read_json(os.path.join(d, "meta.json")) or {}
        samples = read_samples(os.path.join(d, "samples.csv"))

        db = {}
        p = os.path.join(d, "db-totals.txt")
        if os.path.exists(p):
            txt = io.open(p, encoding="utf-8-sig").read()
            for part in txt.replace("\n", " ").split():
                if "=" in part:
                    k, v = part.split("=", 1)
                    try:
                        db[k] = float(v)
                    except ValueError:
                        pass

        runs.append({
            "tag": tag,
            "nodes": int(meta.get("nodes", 0) or 0),
            "config": meta.get("config"),
            "script": meta.get("script"),
            "completed": metric(s, "completed_checkouts", "count"),
            "completed_rate": metric(s, "completed_checkouts", "rate"),
            "success_rate": metric(s, "checkout_success", "value"),
            "http_reqs": metric(s, "http_reqs", "count"),
            "http_fail_rate": metric(s, "http_req_failed", "value"),
            "p95_ms": metric(s, "http_req_duration", "p(95)"),
            "med_ms": metric(s, "http_req_duration", "med"),
            "avg_ms": metric(s, "http_req_duration", "avg"),
            "checkout_avg_ms": metric(s, "checkout_duration", "avg"),
            "checkout_p95_ms": metric(s, "checkout_duration", "p(95)"),
            "steps": {
                n: {
                    "avg": metric(s, "step_" + n, "avg"),
                    "p95": metric(s, "step_" + n, "p(95)"),
                }
                for n in ("browse", "create_cart", "add_item", "addresses",
                          "shipping_options", "shipping_method",
                          "payment_collection", "payment_session", "complete")
                if metric(s, "step_" + n, "avg") is not None
            },
            "db": db,
            "samples": samples,
        })
    return runs


def fmt(v, suffix="", nd=2):
    return "-" if v is None else f"{round(v, nd)}{suffix}"


def main():
    runs = collect()
    if "--json" in sys.argv:
        print(json.dumps(runs, indent=2))
        return

    print(f"{'run':<16}{'nodes':>6}{'done':>7}{'rate/s':>9}{'p95 s':>9}"
          f"{'fail%':>8}{'appCPU%':>9}{'pgCPU%':>8}{'qwait':>7}")
    print("-" * 79)
    for r in runs:
        s = r["samples"]
        print(f"{r['tag']:<16}{r['nodes']:>6}"
              f"{fmt(r['completed'], nd=0):>7}"
              f"{fmt(r['completed_rate'], nd=3):>9}"
              f"{fmt((r['p95_ms'] or 0) / 1000, nd=1):>9}"
              f"{fmt((r['http_fail_rate'] or 0) * 100, nd=2):>8}"
              f"{fmt(s.get('app_cpu_pct', {}).get('peak'), nd=0):>9}"
              f"{fmt(s.get('pg_cpu_pct', {}).get('peak'), nd=0):>8}"
              f"{fmt(s.get('q_wait', {}).get('peak'), nd=0):>7}")

    scale = sorted([r for r in runs if r["tag"].startswith("scale-") and r["completed"]],
                   key=lambda r: r["nodes"])
    if len(scale) > 1:
        base = scale[0]
        print("\nscaling curve (throughput relative to 1 node)")
        for r in scale:
            ratio = r["completed"] / base["completed"] if base["completed"] else 0
            ideal = r["nodes"] / base["nodes"] if base["nodes"] else 0
            eff = (ratio / ideal * 100) if ideal else 0
            print(f"  {r['nodes']} node(s): {int(r['completed']):>4} checkouts  "
                  f"{ratio:.2f}x  (linear would be {ideal:.2f}x, efficiency {eff:.0f}%)")


if __name__ == "__main__":
    main()
