# Runway stress test — how far the markdown model goes

**Date:** 2026-09-02 · **App:** runway.html v1.1.0 · **Method:** measured, not estimated —
the real `MD.parse` / `MD.serialise` / `Util.hash` extracted from `runway.html` (the same way
`test.js` does) driven by `stress/stress-node.js`, and the real UI in headless Chromium 141
driven by `stress/stress-dom.js`. Raw numbers: `stress/results/*.json`.
Test machine: Intel Xeon 2.80GHz (server-class, roughly comparable to a mid-range laptop
core; treat absolute numbers as ±2×, the shapes as reliable).

## TL;DR — the numbers that matter

| Zone | Open tasks in the list | Total items in the file (incl. completed) |
|---|---|---|
| **Comfortable** | ≤ 500 | ≤ 5,000 (~430 KB) |
| **Noticeably sluggish** | ~1,000–2,000 (0.4–1.6 s freeze per action) | ~20,000 (~1.7 MB, ~350 ms CPU per autosave) |
| **Painful** | ~5,000 (2–4 s freeze per action) | ~50,000 (~4.3 MB, >1 s per autosave, ~0.6 s parse on load) |
| **Broken / data-risk** | ~10,000+ (freezes >5 s) | ~125,000 in one section → **serialiser crashes, autosave permanently fails** |

The binding constraint is the **UI, not the file format**: the app re-renders the whole
list on every mutation with no virtualisation, so *open* tasks are what hurt. The parser
and serialiser themselves are honest, linear, and lossless well past 100k items.
**Sub-tasks are collapsed by default and cost almost nothing in the DOM; keep any one
task under ~1,000 sub-task/note lines and they're a non-issue in the file too.**

Reliability is a different story from speed: nothing in the format corrupts gradually.
Every scale we tested round-tripped **byte-identical**. The failures we found are
specific and reproducible (below), not creeping unreliability.

---

## 1. Engine limits (Node, real modules, median of repeated runs)

Realistic files: 30% completed, 65% of open tasks dated, 25% with 0–3 subtasks, 15% with notes.

| tasks | file size | parse | serialise | saveCycle¹ | retained heap |
|---:|---:|---:|---:|---:|---:|
| 100 | 8.7 KB | 1.3 ms | 0.2 ms | 1.6 ms | 0.2 MB |
| 1,000 | 86 KB | 15 ms | 1.6 ms | 12 ms | 0.3 MB |
| 5,000 | 433 KB | 58 ms | 11 ms | 99 ms | 2.3 MB |
| 10,000 | 865 KB | 166 ms | 27 ms | 135 ms | 3.6 MB |
| 20,000 | 1.7 MB | 223 ms | 43 ms | 345 ms | 7.4 MB |
| 50,000 | 4.3 MB | 605 ms | 230 ms | 1.13 s | 22 MB |
| 100,000 | 8.7 MB | 1.47 s | 498 ms | 2.61 s | 37 MB |
| 200,000 | 17.3 MB | 2.65 s | 991 ms | 5.27 s | 74 MB |

¹ `saveCycle` = serialise + hash×2 + re-parse — the synchronous CPU the app spends **on the
main thread** for every autosave flush (800 ms debounce after each change). On top of the
render cost, a file-connected app at 50k items stalls >1 s per save. `Util.hash` alone
(what every window-focus external-change check costs after the async file read) is 3 ms at
10k, 71 ms at 200k — never the problem.

Every row: parse → serialise round-trip **byte-identical**; an edited task in the middle
survives a save/reload cycle intact.

### Sub-tasks

One task with M subtasks (parse / serialise / per-toggle bookkeeping²):

| subtasks | parse | serialise | toggle bookkeeping² |
|---:|---:|---:|---:|
| 100 | 0.3 ms | 0.1 ms | ~0.1 ms |
| 1,000 | 2.5 ms | 0.3 ms | ~0.6 ms |
| 10,000 | 30 ms | 13 ms | ~16 ms |
| 50,000 | 207 ms | 79 ms | ~62 ms |

² every subtask toggle deep-clones the whole subtask array and re-fingerprints the task,
then pays a full save cycle. 5,000 tasks × 50 subtasks each (250k subtasks, 7.3 MB) still
parses in 0.6 s and round-trips byte-identical. **Practical guidance: subtasks are free at
sane counts; a single task only gets weird past ~10k lines under it — and crashes the
serialiser past ~125k (finding F1).**

## 2. UI limits (headless Chromium, real app, tasks seeded into IndexedDB)

All figures ms. *Stall* = longest main-thread freeze (longest rAF gap) in the 2.5 s after
the interaction; idle baseline gap was 17–138 ms, so treat anything ≥200 ms as real.

| scenario | rows rendered | load | toggle stall | search stall | add-task stall | DOM nodes | JS heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| 100 open | 100 | 55 | 68 | 19 | 54 | 3,484 | 1.5 MB |
| 500 open | 500 | 104 | 155 | 28 | 232 | 16,618 | 3.3 MB |
| 1,000 open | 1,000 | 173 | 352 | 69 | 615 | 32,964 | 5.8 MB |
| 2,000 open | 2,000 | 276 | 805 | 99 | 1,564 | 65,597 | 9.0 MB |
| 5,000 open | 5,000 | 683 | 3,777 | 211 | 2,314 | 163,550 | 14.4 MB |
| 10,000 open | 10,000 | 1,531 | 3,442 | 2,090 | 6,437 | 326,830 | 33.7 MB |
| 20,000 open | 20,000 | 2,529 | 5,822 | 2,005 | 10,919 | 653,320 | 90.6 MB |
| 50,000 open | 50,000 | 7,555 | 1,916 ³ | 9,928 | **53,356** | 1,632,802 | 130 MB |
| **20k total, 5% open** | 1,032 | 577 | 357 | 138 | 517 | 34,012 | 35.6 MB |
| **1k × 10 subtasks** | 1,000 | 199 | 361 | 59 | 648 | 33,964 | 7.8 MB |

³ under-measured: at 50k the model/journal bookkeeping delays the re-render past the 2.5 s
probe window; the true toggle stall is at least the 20k figure.

Interpretation:

- **Load** = navigation → list fully rendered: 1.5 s at 10k open, 2.5 s at 20k, 7.6 s at 50k.
- **Toggle/add stall** is the real ceiling. The app rebuilds the entire list DOM on every
  mutation (~33 DOM nodes per row), so re-renders cost more than first render
  (teardown + GC): **~1,000 open ≈ 0.35–0.6 s per action; 2,000 ≈ 0.8–1.6 s; 5,000 ≈
  2–4 s; 20,000 ≈ 6–11 s; 50,000 ≈ up to 53 s.** These figures are render-only (no file
  connected) — with a file connected, add the saveCycle column from §1 to each action.
- **Search** stays cheaper (100 ms debounce, and filtered result sets render fewer rows).
- **Completed items are DOM-free**: a 20k-item file with only ~1k open loads in 577 ms
  and toggles in 357 ms — identical to a 1k list. The completed view is capped (200 rows,
  last-7-days window). DOM cost tracks *open* tasks; file cost tracks *total* items.
- **Collapsed subtasks are DOM-free too**: 1k tasks × 10 subtasks each measures the same
  as 1k plain tasks (199 ms load / 361 ms toggle; node count unchanged). Subtasks only
  enter the DOM for rows you expand.

## 3. Robustness — what the app's error handling actually covers

Verified by test (all in `stress-node.js` robustness corpus):

| Mechanism | Verdict |
|---|---|
| Unparseable dates (`📅 2026-02-31`) | ✅ 10k of them: all reported in the banner (`problems`), tasks kept as undated, lines preserved byte-for-byte |
| Duplicate explicit `^ids` | ✅ 10k duplicates: fresh ids assigned, zero content loss (but one `console.warn` per dup — 9,999 warns) |
| Garbage / fuzz content | ✅ 50k fuzz lines around 5k real tasks: every real task recovered, every fuzz byte preserved |
| Non-task markdown (prose, other headings) | ✅ 1M prose lines + 1 task: parsed in 0.5 s, prose untouched byte-for-byte |
| 5 MB single-line title | ✅ parses in 82 ms, round-trips |
| Mixed CRLF/LF | ✅ majority EOL wins; file is normalised on save, no content change |
| Nested checklists | ✅ flatten to one level of subtasks in the model, but the file keeps the nesting until you edit that task |
| Conflict detection (external edits) | ✅ mtime + FNV-1a hash of whole file; conflict banner with LCS diff (diff self-caps at ~2k×2k lines and degrades gracefully) |
| Invalid IndexedDB records | ✅ quarantined with a banner, left untouched in storage |
| Storage quota exhaustion | ✅ dedicated banner (which, notably, already tells the user to *archive* — the feature doesn't exist yet) |
| Write failures | ✅ one 2 s retry, then a persistent "save failing / Retry" banner; IndexedDB keeps the current state meanwhile |
| Crash safety of writes | ✅ by design: File System Access API writes go to a temp file and swap on `close()` — a torn write can't half-corrupt todo.md, and the dirty flag + IndexedDB replay unsaved state on next launch |

### Findings (defects demonstrated by the harness)

| # | Severity | Finding |
|---|---|---|
| **F1** | **High (crash)** | `MD.serialise` uses spread (`lines.push(...e.lines)`, `entries.push(...newEntries)`) and **throws `RangeError: Maximum call stack size exceeded` at ≈125,546 lines** in one entry or one batch. Two real triggers: (a) a single task whose note+subtasks exceed ~125k lines — autosave of that file **permanently fails** (data stays in IndexedDB, file goes stale, "save failing" banner forever); (b) "Save as new file"/first connect when ~125k+ tasks must be placed into one section at once. Fix is one line each: replace spread with a loop/`concat`. |
| **F2** | **High (silent data loss, rare)** | Generated-id collisions. Tasks without `^ids` get random 6-char ids checked against the live model but **not against ids generated in the same parse**. Two colliding *dated* tasks → on next save one task's content is silently replaced by the other's (deterministically reproduced in R3a). Measured frequency on id-less imports: 10k tasks → ~3% chance of losing 1 task; 50k → ~20%; 100k → ~100% (avg 2.4 tasks lost per import, 12 lost across 5 trials). Normal app-written files carry `^ids` and are immune; the risk is **bulk-importing large hand-written/Obsidian files**. Fix: check `seenIds` inside the generation loop. |
| **F3** | **Medium (title mangling)** | The `^id` extractor takes the *first* ` ^token ` anywhere in the line. A title like `Review PR ^123 for the parser ^k3f9qm` loses `^123` from the title *and* keeps the real trailing id as literal title text. Any mid-title `^word` token is silently deleted on first parse. |
| **F4** | **Low** | A UTF-8 BOM is detected and stripped on parse but never written back — the first save rewrites the file without its BOM (can trip other tooling that expects it). |
| **F5** | **Low (UX at scale)** | Import path (`Model.replaceAll`) writes each task in its own awaited IndexedDB transaction: measured 0.5 ms/record vs 0.08 ms bulk — a 10k-task import spends ~5 s in IDB alone (plus 9,999 `console.warn`s if ids collide with existing ones). |

## 4. Hard ceilings (for completeness)

- **Serialiser crash:** ~125k lines in one entry/section (F1) — the only true "file becomes unsaveable" cliff we found.
- **Memory:** parse result retains ~0.4 KB/task (37 MB at 100k); the browser roughly doubles that with the model + DOM. Not the binding constraint.
- **Id space:** 36⁶ ≈ 2.18 billion — collisions between *existing* ids are a non-issue below millions of tasks; only generation-in-one-parse collides (F2).
- **32-bit content hash (FNV-1a)** for conflict detection: a false "no conflict" needs a 1-in-4-billion collision on a changed file — acceptable.
- **Undo journal** self-caps at 500 entries; completed view caps at 200 rows / 7 days — both already defend the UI.

## 5. Should you archive old completed items? Yes — but for file cost, not UI cost

The UI already protects itself from completed items (hidden + capped). What grows without
bound is the **file**, and with it: load parse, every autosave's main-thread saveCycle,
every window-focus hash check, and (F1) the theoretical crash ceiling.

Concrete horizon: at 30 completions/day, the Completed section grows ~11k items/year
(~1 MB/year). Year 1 ≈ imperceptible (135 ms saves). Year 2–3 ≈ 350 ms+ per save and
~250 ms parse on every load — noticeable on battery-powered laptops. Year 5 ≈ >1 s per
save. Nothing breaks — it just gets steadily worse, and 100% of that cost is paid for
items the user can no longer even see in the UI.

**Recommendation:** add a manual/prompted "Archive completed" action rather than an
automatic one (the file is user-owned markdown; silent removal would violate the app's
own promise to preserve content):

1. Trigger: banner suggestion when Completed exceeds ~5,000 items or the file exceeds
   ~1 MB (both thresholds are where saveCycle crosses ~100 ms on our numbers).
2. Action: move `## Completed` entries with `doneAt` older than `showCompletedDays`
   (or 90 days) into `todo-archive-YYYY.md` alongside the file (folder mode already has
   a directory handle; single-file mode can offer a save-as). Append-only, same task
   syntax, ids preserved — the archive stays a valid Runway/Obsidian-Tasks file.
3. Keep stats honest: `Stats.throughput` only looks back 8 weeks, so archiving >90-day
   items never changes what the stats panel shows.

With that policy in place the working file stays at "open + recent completed" — a few
hundred to a few thousand items — which is **permanently inside the comfortable zone**,
and the practical limit becomes the UI's ~1–2k *open* tasks, which is a human limit, not
a technical one.

## 6. Reproduce

```sh
node --expose-gc stress/stress-node.js --out stress/results/node.json
node stress/stress-dom.js --out stress/results/dom.json   # needs Playwright + Chromium
node test.js                                              # app's own suite still 146/146
```
