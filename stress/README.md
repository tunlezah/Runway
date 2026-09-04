# Runway stress tests

Two harnesses that measure where Runway's markdown-file model stops being fast,
and prove what its parser/serialiser does under abuse. Both run against the real
code inside `runway.html` (extracted the same way `test.js` does) — nothing is
mocked or reimplemented except the file generators.

## stress-node.js — engine limits (no browser)

Measures the exact CPU cost of the operations the app runs on every load, save
and window focus, at 100 → 200,000 tasks, plus subtask scaling and a robustness
corpus (invalid dates, duplicate/missing `^ids` at scale, fuzz, giant lines,
giant notes, mixed EOL, BOM, adversarial titles, serialiser crash thresholds).

```sh
node --expose-gc stress/stress-node.js [--quick] [--out stress/results/node.json]
```

`--quick` runs a reduced matrix in ~1 minute. Symbols in the robustness output:
`✓` behaved safely · `⚠ FINDING` defect demonstrated · `✗` unexpected failure.

## stress-dom.js — what the user feels (headless Chromium)

Serves `runway.html` on localhost, seeds N tasks straight into the app's
IndexedDB, reloads, and measures initial render time, the longest main-thread
stall after completing a task / typing a search / adding a task (the app
re-renders the whole list on every mutation), DOM node count and JS heap.

```sh
node stress/stress-dom.js [--quick] [--out stress/results/dom.json]
```

Uses the globally installed Playwright; launches Chromium with `--no-sandbox`
(needed in rootful containers).

## robust-fuzz.js — properties, not sizes (no browser)

Property-based checks on the pure engine: random markdown files must parse
without throwing and round-trip byte-identical apart from appended `^ids`;
random task objects must survive model → file → model in every metadata
style; the date language, entry parser and search must never throw; records
that `Model.validate` accepts must not break the renderer. Deterministic
(`--seed`), ~40 s.

```sh
node stress/robust-fuzz.js [--seed 1] [--iters 400] [--out stress/results/robust-fuzz.json]
```

## tz-matrix.js — the date engine around the world (no browser)

Spawns one child per time zone (31 zones, including DST-at-midnight, negative
DST, 30-minute DST and :45 offsets) and walks every day of 2024–2027 checking
the invariants the app relies on; also runs `test.js` under each zone and with
the clock frozen inside DST gaps, at New Year and on a leap day.

```sh
node stress/tz-matrix.js [--quick]
```

## robust-browser.js — failure injection in the real UI (headless Chromium)

Seventeen scenarios against the live app with an Origin-Private-File-System
file standing in for `todo.md`: two tabs on one list, a corrupt stored record,
an IME composition Enter, Space on a focused button, double Enter, a Latin-1
file, hostile settings JSON, a full scripted session watched for page errors,
IndexedDB blocked / quota exceeded, closing the tab mid-autosave, external
edits, undo after a reload, a malformed stored id, and (S14–S17, from the
data-integrity audit) the first-connect banner with a task typed / Ctrl+S /
tab hidden and a failing first read, a change committed while a write is in
flight, an import of an older export, and Firefox-mode export after a reload.

```sh
node stress/robust-browser.js [--only S2,S6] [--out stress/results/robust-browser.json] [--fail-on-new]
```

`--fail-on-new` (also on `robust-fuzz.js`) exits 1 on a harness error or a
finding outside the documented open Lows, which is how CI runs both.

Symbols in the robustness harnesses: `✓` behaved · `⚠ FINDING` defect
demonstrated · `✗` harness error. The checks assert the *intended* behaviour,
so a `⚠` turning `✓` is a fix landing.

## Results

`results/node.json` and `results/dom.json` are the measured runs backing
`docs/stress-test-report.md`. Machine: see the `meta` block in each file —
re-run on your own hardware before treating any absolute number as gospel;
the shapes (linear file costs, quadratic-feeling UI costs) are what transfer.
`results/robust-fuzz.json`, `results/tz-matrix.txt` and
`results/robust-browser.json` back `docs/robustness-check-report.md`.
