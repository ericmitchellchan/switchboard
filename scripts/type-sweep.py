#!/usr/bin/env python3
"""THE TYPE SWEEP, DRY RUN (SWIT-115) — the playbook's "inventory first, decide second".

Finds every hand-set font size in the shell (src/, excluding src/projects —
Lodestar's Tailwind pages are a separate decision — and test files) and
proposes the type-scale token for each:

  - the SIZE picks the step, rounded to the nearest one with the 11px floor:
      <= 11 -> 11 · 11.5-12 -> 12 · 12.5-14 -> 13 · 15-17 -> 16 · 18-22 -> 20 · >= 24 -> 28
  - the FACE set in the same style object picks the token at that step:
      mono (MONO / var(--font-mono) / monospace) -> label / mono / metric
      uppercase on mono -> kicker; everything else -> caption / bodySm / body…
  - weight 600+ at 13 -> subheading; 16 -> heading, 20 -> title, 28 -> display.

It changes NOTHING. Every site prints as  file:line  size  face  -> token  [flags]
and a summary groups them by folder and by proposal. Flags mark what a person
decides (the playbook's REVIEW / LOOK lines):

  ROUNDED    the size had no step and was rounded (most of ours: 10, 10.5, 12.5…)
  NO-FACE    no family in the object — inherited from somewhere; read the JSX
  CSS        a font-size inside a CSS string (MarkdownDoc's DOC_CSS etc.)
  EM         an em/rem size — relative to its parent; leave or mark off-scale
  DYNAMIC    a variable or conditional size — read it

Usage:  python scripts/type-sweep.py [--folder src/components/kb] [--summary]
"""

from __future__ import annotations

import argparse
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SKIP_PARTS = {"projects"}
SKIP_FILES = {"typeScale.ts"}

SIZE_RE = re.compile(r"\bfontSize\s*[:=]\s*\{?\s*([^,}\n]+)")
CSS_RE = re.compile(r"font-size\s*:\s*([0-9.]+)(px|em|rem)")
MONO_RE = re.compile(r"MONO\b|--font-mono|monospace|T\.(label|mono|kicker|metric)")
READING_RE = re.compile(r"READING\b|--font-reading|T\.(body|caption|heading|title|display|doc|subheading)")
UPPER_RE = re.compile(r"textTransform\s*:\s*[\"']uppercase")
WEIGHT_RE = re.compile(r"fontWeight\s*:\s*(\d{3})")


def step_for(px: float) -> int:
    if px <= 11:
        return 11
    if px <= 12:
        return 12
    if px <= 14:
        return 13
    if px <= 17:
        return 16
    if px <= 22:
        return 20
    return 28


STEPS_EXACT = {11, 12, 13, 16, 20, 28}


def token_for(step: int, face: str, upper: bool, weight: int) -> str:
    if face == "mono":
        if step == 11:
            return "kicker" if upper else "label"
        if step <= 13:
            return "mono"
        return "metric" if step <= 20 else "metricLg"
    return {
        11: "caption",
        12: "bodySm",
        13: "subheading" if weight >= 600 else "body",
        16: "heading",
        20: "title",
        28: "display",
    }[step]


def object_window(lines: list[str], i: int, radius: int = 8) -> str:
    """The style object around line i — up to the nearest braces, capped."""
    lo = i
    while lo > 0 and i - lo < radius and "{" not in lines[lo]:
        lo -= 1
    hi = i
    while hi < len(lines) - 1 and hi - i < radius and "}" not in lines[hi]:
        hi += 1
    return "\n".join(lines[lo : hi + 1])


def scan(paths: list[Path]):
    for path in paths:
        rel = path.relative_to(ROOT).as_posix()
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        for i, line in enumerate(lines):
            if "off-scale:" in line or (i > 0 and "off-scale:" in lines[i - 1]):
                continue
            for m in CSS_RE.finditer(line):
                size, unit = float(m.group(1)), m.group(2)
                if unit != "px":
                    yield rel, i + 1, f"{m.group(1)}{unit}", "?", "-", ["CSS", "EM"]
                    continue
                step = step_for(size)
                flags = ["CSS"] + ([] if size in STEPS_EXACT else ["ROUNDED"])
                yield rel, i + 1, m.group(1), "?", token_for(step, "reading", False, 400), flags
            m = SIZE_RE.search(line)
            if not m or "var(--t-" in line:
                continue
            raw = m.group(1).strip().strip("\"'`")
            num = re.fullmatch(r"([0-9.]+)(px)?", raw)
            if not num:
                unit = re.fullmatch(r"[0-9.]+(em|rem)", raw)
                yield rel, i + 1, raw[:24], "?", "-", ["EM"] if unit else ["DYNAMIC"]
                continue
            size = float(num.group(1))
            win = object_window(lines, i)
            face = "mono" if MONO_RE.search(win) else "reading" if READING_RE.search(win) else "?"
            weight_m = WEIGHT_RE.search(win)
            weight = int(weight_m.group(1)) if weight_m else 400
            step = step_for(size)
            flags = [] if size in STEPS_EXACT else ["ROUNDED"]
            if face == "?":
                flags.append("NO-FACE")
            yield rel, i + 1, num.group(1), face, token_for(step, "mono" if face == "mono" else "reading", bool(UPPER_RE.search(win)), weight), flags


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--folder", default="src", help="limit to a folder (default src)")
    ap.add_argument("--summary", action="store_true", help="print only the summary")
    args = ap.parse_args()
    base = (ROOT / args.folder).resolve()
    files = sorted(
        p
        for p in base.rglob("*")
        if p.suffix in (".ts", ".tsx")
        and not p.name.endswith(".test.ts")
        and p.name not in SKIP_FILES
        and not (SKIP_PARTS & set(p.relative_to(SRC).parts))
    )
    rows = list(scan(files))
    if not args.summary:
        for rel, ln, size, face, token, flags in rows:
            print(f"{rel}:{ln}  {size:>6}  {face:<7} -> {token:<11} {' '.join(flags)}")
    by_folder: Counter[str] = Counter()
    by_token: Counter[str] = Counter()
    flagged: dict[str, int] = defaultdict(int)
    for rel, _ln, _size, _face, token, flags in rows:
        parts = rel.split("/")
        by_folder["/".join(parts[:3]) if len(parts) > 3 else rel] += 1
        by_token[token] += 1
        for f in flags:
            flagged[f] += 1
    print(f"\n{len(rows)} hand-set sizes in {len(files)} files")
    print("by area:  " + " · ".join(f"{k} {v}" for k, v in by_folder.most_common()))
    print("proposed: " + " · ".join(f"{k} {v}" for k, v in by_token.most_common()))
    print("flags:    " + " · ".join(f"{k} {v}" for k, v in sorted(flagged.items(), key=lambda kv: -kv[1])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
