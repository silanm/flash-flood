#!/usr/bin/env python3
"""Edge vs cloud_only alarm latency per link condition (Section V), from eval/results/replay_results_2026-11-10.csv.

Bars: median CRITICAL latency, whiskers min-max; a cell with no alarm is marked "no alarm".
Usage: python latency_plot.py [out_dir]   -> Latency_edge_vs_cloud.{pdf,png}
"""
import csv, os, statistics, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "..", "results", "replay_results_2026-11-10.csv")
OUT = sys.argv[1] if len(sys.argv) > 1 else HERE
CONDS = [("clean", "Clean"), ("impaired", "Impaired"), ("down", "Link down")]
MODES = [("edge", "Edge (Pi decides)", "#2b6cb0"), ("cloud_only", "Cloud-only baseline", "#c05621")]

rows = list(csv.DictReader(open(CSV)))
plt.rcParams.update({"font.size": 8, "font.family": "serif"})
fig, ax = plt.subplots(figsize=(3.4, 2.1))
w = 0.38
for j, (mode, label, colour) in enumerate(MODES):
    for i, (cond, _) in enumerate(CONDS):
        cell = [r for r in rows if r["mode"] == mode and r["condition"] == cond]
        v = [int(r["crit_ms"]) for r in cell if r["crit_ms"]]
        x = i + (j - 0.5) * w
        if not v:
            ax.text(x + 0.08, 3, f"no alarm\n(0 of {len(cell)})", ha="center", va="bottom", fontsize=6.5, color=colour, zorder=5)
            continue
        m = statistics.median(v)
        ax.bar(x, m, w, color=colour, label=label if i == 0 else None)
        ax.errorbar(x, m, yerr=[[m - min(v)], [max(v) - m]], color="black", capsize=2, lw=0.8)
        ax.text(x, max(v) * 1.25, f"{m:.0f}", ha="center", va="bottom", fontsize=6.5)
ax.set_yscale("log")
ax.set_ylim(2, 2e4)
ax.set_xlim(-0.6, len(CONDS) - 0.25)   # room for the "no alarm" label of the last cell
ax.set_ylabel("CRITICAL latency (ms)")
ax.set_xticks(range(len(CONDS)), [c[1] for c in CONDS])
ax.legend(loc="upper left", fontsize=6.5, frameon=False)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout(pad=0.3)
for ext in ("pdf", "png"):
    fig.savefig(os.path.join(OUT, f"Latency_edge_vs_cloud.{ext}"), dpi=300)
print("saved to", OUT)
