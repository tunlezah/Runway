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

## Results

`results/node.json` and `results/dom.json` are the measured runs backing
`docs/stress-test-report.md`. Machine: see the `meta` block in each file —
re-run on your own hardware before treating any absolute number as gospel;
the shapes (linear file costs, quadratic-feeling UI costs) are what transfer.
