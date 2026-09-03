# Runway robustness check — what breaks when the world is not tidy

**Date:** 2026-09-03 · **App:** runway.html v1.2.1 (findings) → **v1.3.0 (fixes applied)** · **Status:** the two High findings, all four Medium findings, and a newly found quadratic-parse defect are **fixed and verified on this branch**; see [Fixes applied](#fixes-applied-v130). The remaining Low findings are documented, not yet fixed.

**Method:** a full read of the source, then three new harnesses that run the real code (nothing mocked
but the inputs): `stress/robust-fuzz.js` (property-based checks on the parser, serialiser, date
language, entry parser, search and record validation — 46 properties, seed 1, 400 iterations),
`stress/tz-matrix.js` (every day of 2024–2027 in 31 time zones, plus the embedded suite under each
zone and with the clock frozen at awkward instants) and `stress/robust-browser.js` (13 failure-injection
scenarios against the live UI in headless Chromium 141, with the Origin Private File System standing in
for a real `todo.md`). Raw results: `stress/results/robust-fuzz.json`, `stress/results/tz-matrix.txt`,
`stress/results/robust-browser.json`.

This complements, and does not repeat, the two earlier passes: the stress test (scale and speed,
`docs/stress-test-report.md`) and the v1.2.0 reliability review of the persistence paths. The
question here is different: **what happens when input, storage, time, or the user's other tab
misbehave?**

---

## TL;DR

**17 defects, none of them speed-related in normal use — but one is a parser blow-up on hostile
input.** Two can lose or mangle data through ordinary use; five change state, break a view, or freeze
the tab in plausible situations; ten are small. Everything the earlier passes hardened still holds, and
a lot of new ground held too (see *What held*). **The two High, all five Medium, and R17 are fixed and
verified on this branch (v1.3.0)** — see [Fixes applied](#fixes-applied-v130); the ten Low findings are
documented and left for a follow-up.

| # | Severity | Fixed | Finding | Evidence |
|---|---|---|---|---|
| R1 | **High** | ✅ v1.3.0 | The same list open in **two tabs** turns one tab's write into a "changed outside this app" conflict in the other; "Keep my version" then deletes the first tab's task from the file, the browser store and the first tab. Both offered choices lose one side; the "Keep both" merge the code has is not offered. | S2 |
| R2 | **High** | ✅ v1.3.0 | A **non-UTF-8 file** (Latin-1/Windows-1252, UTF-16, or binary) is decoded with replacement characters, connected silently, and rewritten on the first save — every accented byte becomes `�`, including prose the app promises never to touch. | S6, G8, G9 |
| R17 | **High** (hostile input) | ✅ v1.3.0 | Two parser regexes are **quadratic on adversarial lines**: a task line followed by ~80,000 spaces takes ~6 s and quadruples per doubling (a 300 KB line ≈ 90 s); a line with thousands of unclosed `[due:: ` fields behaves the same. Reachable through Import, a synced `todo.md`, or a backup. No data lost — the tab just freezes. | R17 probe |
| R3 | Medium | ✅ v1.3.0 | One stored task with an unreadable completion date passes validation (only `due` is checked) and then **crashes the completed view, the stats panel and `is:done` search** with a blank result, no banner, no quarantine, no recovery short of a reload. | S1, G3, F2, F3 |
| R5 | Medium | ✅ v1.3.0 | Free text containing **metadata-looking tokens** (`📅 2026-01-01`, `⏫`, `✅ …`, `[due:: …]`, `[priority:: …]`) is re-interpreted on the next load: a title's real due date is replaced, priority is forced, sub-task text is split. The entry field strips `#tag`/`[d]`/`!!` but not these. | G4–G6, B |
| R6 | Medium | ✅ v1.3.0 | **IME users:** the Enter that confirms a Japanese/Chinese/Korean composition adds the task with the half-composed text and clears the box. No Enter handler checks `isComposing`. | S3 |
| R7 | Medium | ✅ v1.3.0 | The **undo journal survives a reload from disk**: after an external edit is auto-loaded, Ctrl+Z replays the pre-reload history and can delete or revert the externally edited task — from the file too. | S12 |
| R4 | Low | — | A stored record whose id is malformed is repaired in memory only; the first edit stores a second copy and **the task is duplicated** on the next load. | S13 |
| R8 | Low | — | With a task selected, **Space on a focused row button** completes the selected task instead of pressing the button (Enter works). Keyboard-only users hit this. | S4 |
| R9 | Low | — | Two Enter presses before the first add clears the box add **the task twice**. | S5 |
| R10 | Low | partial | `[constructor]` or `[__proto__]` in a title is treated as a **tag shortcut**: the word is deleted from the title and a function/object is pushed as a tag. v1.3.0 stops the non-string tag reaching the model (the prototype-pollution risk is gone); the title still loses the bracket word. | G1, G2, D2, D3 |
| R11 | Low | — | Tag labels containing `_` or `#` **do not round-trip** (`snake_case` → "snake case", `C#` → tag `C` plus a stray `#` in the title). Settings accept any label. | B tag-hazard |
| R12 | Low | — | Importing a settings file whose JSON is not an object (`null`, a string, a list) **silently resets every setting** to defaults instead of refusing. | S7b |
| R13 | Low | — | A Unicode line/paragraph separator (U+2028/U+2029) inside a task line makes the **task invisible to the parser** with no "unreadable line" report; inside a sub-task or note line it detaches that line from its task. | G16, G17 |
| R14 | Low | — | Byte-preservation edges: a completed line without a `✅` date is rewritten with a synthetic date on the first save after a day passes; trailing whitespace on a hand-written line is trimmed when the id is appended. | G10, G11, A3 |
| R15 | Low | — | Four-digit years below 100 (`12 5 0050`, `📅 0050-06-01`) resolve or display as 19xx — the two-digit-year quirk of `new Date(y, m, d)`. | G12, G13, C3 |
| R16 | Low | — | With *Write block IDs* off, an undated task whose title ends in a six-character `^token` gets that token as its id on reload and loses it from the title. | G7 |

Severity: **High** = data loss, an unreadable file, or a tab freeze through ordinary use or reachable
hostile input · **Medium** = state silently changes or a feature breaks in a plausible situation,
recoverable · **Low** = rare, cosmetic, or needs unusual input; fix is small.

---

## Fixes applied (v1.3.0)

Everything below was changed in `runway.html` on this branch and verified by the harnesses named. The
embedded suite grows from 162 to **180 tests** (`node test.js`, green); the property harness now holds
**25 / 46** properties (was 12), with the remainder tracking the ten Low findings left open.

- **R17 · quadratic parser regexes (found while fixing R5).** `TASK_RE`'s body group `(.*\S.*)` and the
  `[due:: …]` field pattern `\[\s*due::\s*([^\]]*)\]` both backtrack quadratically. Measured before:
  a `- [ ]` line with 40,000 trailing spaces parsed in ~1.5 s (4× per doubling → ~90 s at 300 KB); a
  line with 8,000 unclosed `[due:: ` tokens, ~0.7 s; the same shape in a `## ` heading and in the
  serialiser's stale-id trim. **Fix:** the task body group is now `(\S.*)` (identical captures, no
  backtracking); every `[key:: value]` field is located with a non-backtracking scan
  (`bracketFields`: match the key, then `indexOf("]")`); the heading is matched by character checks and
  `trim()`; the serialiser uses `trimEnd()`. **After:** all four cases parse/serialise in **under
  10 ms at 320,000 characters** — a differential test over 300,000 random strings confirms the new
  regexes produce byte-identical captures to the old ones. Verified by the "parse and serialise cost
  stays linear on hostile lines" test in the embedded suite and a timing probe.

- **R5 · reserved syntax in free text now honoured at entry, not re-read on load.** `EntryParse.parse`
  and the sub-task add/rename paths now run the file's own grammar (`MD.extractBody` / `MD.subDue`), so
  a `📅 date`, a `⏫`/`[priority:: …]`, a `✅`/`[completion:: …]` or a `[due:: …]` typed into a title or
  sub-task becomes real metadata immediately and shows as a chip — it is never written into free text
  for the next parse to reinterpret. `Model.validate` applies the same normalisation as a backstop, so
  a task reaching the model from any path (import, sync, a hand-edited record) is clean; a title that is
  *only* a token (e.g. `📅 2026-01-01`) is left intact, and an impossible date (`📅 2026-02-30`) is
  flagged in the entry chips rather than silently dropped. The two-machine flip-flop is gone: the
  round-trip regression test drives Pay-invoice-with-a-date and friends through save → load → save and
  asserts the due date and title are stable. Verified by G4–G6, the B token-hazard tiers (0 changed),
  S8c, and three new embedded tests.

- **R2 · non-UTF-8 files are refused, never rewritten.** File reads go through `Util.decodeUtf8`, which
  rejects a UTF-16 BOM, any byte sequence that is not valid UTF-8, and embedded NULs. A file that fails
  connects **read-only**: a red banner and chip say "todo.md isn't UTF-8 text", the app never marks it
  dirty and never writes, and the same guard covers Import and backup restore. "Check again" retries
  after the user converts the file; the browser's own tasks are then offered via the Keep-both chooser
  rather than dropped. Verified by S6a–c, G8, G9.

- **R1 · other tabs on one origin.** A `BroadcastChannel("runway")` broadcasts every task commit and
  settings change; a sibling tab refreshes from the shared store and re-renders (deferred while it is
  mid-edit). Before a write raises a conflict, the app compares the on-disk hash to the shared
  `fileMeta` record: when the file is exactly what another Runway tab wrote, it reloads from storage and
  carries on. The conflict banner now offers **Keep both** (the existing merge), and its wording no
  longer claims an outside program when a sibling tab is the likely cause. Net effect: the focus path
  self-heals silently, and in the worst-case race the banner appears but every choice — including the
  new Keep both — keeps both tabs' work. Verified by S2 (both variants) and S11c.

- **R3 · one bad record can no longer blank the app.** `Model.validate` now rejects/repairs an
  unreadable `doneAt` and coerces non-timestamp `createdAt`/`updatedAt`; `fmtLong`/`fmtShort` return the
  raw string instead of throwing on an unparseable date; `Stats.throughput` guards its `getDay` call;
  `Render.render` is wrapped so any drawing error becomes a banner ("Runway couldn't draw the list …
  Reload / Export") instead of a silent blank; and `window.error` / `unhandledrejection` raise the same
  banner. Verified by S1a–e, G3, F2, F3.

- **R6 · IME composition Enter.** Every Enter handler (entry title and date, title editor, both date
  editors, sub-task add and rename) returns early on `e.isComposing || e.keyCode === 229`, so the Enter
  that confirms a composition no longer adds a half-typed task. Verified by S3/S3b.

- **R7 · undo across a model replacement.** `adopt()` (external reload, first connect, import, restore)
  now clears the undo journal, so Ctrl+Z after a reload can no longer replay stale snapshots over what
  the file says. Verified by S12.

**Not changed on this branch (Low, documented below):** R4, R8, R9, R11–R16, and the title-mangling
half of R10. The security-relevant half of R10 — a non-string tag reaching the model — is closed by the
validate tag filter (fuzz D2 now holds).

---

## What held

Verified, not assumed — each line names the check.

**Parser and serialiser** (400 random files: BOM, CRLF, tabs and 2/4/6-space indents, nested
checklists, odd bullets, headings of every kind, metadata in random order, invalid dates):
- never throw (A1); files whose task lines carry ids round-trip **byte-identical** (A2); a second
  parse→serialise cycle is idempotent (A4); the written file re-parses to the same tasks (A5) and
  introduces no new unreadable lines (A6);
- hand-written lines change only by the appended `^id` (A3) — except the trailing-whitespace edge in R14;
- 5 MB titles, 200k-line notes, 1M prose lines, 10k duplicate ids, 50k fuzz lines: still as reported in
  the stress test (`stress-node.js` robustness corpus, re-run green).

**Date language:** never throws on 20,000 random strings (C1); every resolved date is a valid ISO
date (C2); `+N{d,w,m,b}` resolves for every N ≤ 999 (C4). **Search:** never throws on 8,000 random
queries against 50 random tasks (E1). **Stored records:** validation never throws on any value
IndexedDB can hold (F1).

**Time zones** (`tz-matrix`): ten invariants — `parseISO`/`isoOf` round-trip, `midnight`, day
arithmetic, `+1`/`tom`/weekday names, work-day maths, calendar grid continuity, urgency records,
week-start, the midnight re-render alarm — **held on every one of 1,461 days in all 31 zones**,
including DST-at-midnight zones (Santiago, Asunción, Havana, Nuuk, Scoresbysund), negative DST (Dublin),
30-minute DST (Lord Howe), :45 offsets (Kathmandu, Chatham) and the −12/+14 extremes. The embedded suite
is green under every zone and with the clock frozen inside a US DST gap, one second before New Year,
on a leap day, and inside the EU fall-back hour. The date engine's component-based arithmetic
(`new Date(y, m, d + n)`, `Math.round` over midnight differences) is what makes this work; keep it.

**Persistence under failure** (browser):
- IndexedDB throwing at boot → "Storage is unavailable" banner and a working in-memory list (S9a);
  a `QuotaExceededError` on write → "storage is full" banner, the task stays in the list (S9b);
- tab closed with an autosave still pending → the change survives and reaches the file on the next
  launch (S10) — the dirty-flag replay works as designed;
- external edit while clean → auto-reload with a status banner (S11a); external edit while dirty →
  conflict banner, file untouched (S11b); no page errors (S11c);
- the two-tab case **does** self-heal when the second tab regains focus before acting (S2, variant 2) —
  R1 is the race where it acts first.

**Whole-app session** (add with tags/priority/dates, complete, undo, redo, snooze, priority cycling,
sub-task with date, board drag to a column, calendar navigation and prefill, operator search, stats,
settings changes, shortcuts overlay, completed list, Ctrl+S): **zero page errors** (S8a); the file
reflects it with changed lines in the chosen style and untouched lines verbatim (S8b); Ctrl+S with a
connected file writes instead of downloading (S8c); the embedded suite passes in-page (S8d).

**Security posture** (static): no `innerHTML`, `eval`, `document.write` or `insertAdjacentHTML`; every
node is built with `textContent`/`setAttribute`; ids are validated before they reach a selector; the
CSP is `default-src 'none'` with `connect-src 'none'`; settings import is a whitelist and hostile keys
(`__proto__`, `constructor`) do not pollute `Object.prototype` (S7a); invalid JSON is refused with a
banner (S7c); shortcut keys are limited to 1–3 alphanumerics so the map itself cannot be poisoned
(R10 is a lookup bug, not a poisoning). Nothing here reaches the network.

---

## Findings in detail

### R1 · High · Two tabs, one list — ✅ fixed in v1.3.0

**What happens.** Open the same origin twice (the hosted copy in two tabs, or a pinned tab plus a new
one). Tab A adds a task; the app writes it to `todo.md`. Tab B still holds the model it loaded at boot.
The user completes a task in B: B's autosave sees a newer mtime and a different hash, so it raises the
conflict banner — worded *"todo.md changed outside this app while you had unsaved changes"*. Nothing
outside the app happened. If the user picks **Keep my version** (the natural reading), B serialises its
stale model over the file's structure: A's task block has no model task behind it and is dropped. When
A next regains focus it reloads the file, adopts it, and `replaceAll` deletes the task from IndexedDB.
The task is gone from the file, from both tabs and from storage (S2, variant 1). **Reload from disk**
loses B's completion instead (variant 3). The banner offers no "Keep both" although `Persist.resolveMerge`
exists and is offered in the first-connect banner.

**Why.** Nothing coordinates tabs: `Model` is per-tab memory; `fileMeta` is per-tab memory that also
happens to be mirrored into a shared IndexedDB record; there is no `BroadcastChannel`, `storage`
event or `navigator.locks` use. The focus/visibility check (`checkExternal`) is the only sync, and it
runs only when the tab regains focus — if the user acts first, the race is lost.

**Fix.** Any one of these closes the loss; the first two together give a good experience.
1. Before declaring a conflict in `flush()`/`checkExternal()`, re-read the `fileMeta` record from
   IndexedDB. If *its* `contentHash` equals the on-disk hash, another Runway tab wrote the file:
   reload the model from IndexedDB (records are per-task, so both tabs' commits are already there)
   and carry on — no banner, no choice.
2. A `BroadcastChannel("runway")`: post `{type:"commit", ids}` after every `Model.commit/remove/replaceAll`
   and `{type:"written", meta}` after every write; other tabs refresh those records from IndexedDB and
   re-render, and update their `fileMeta`.
3. Offer **Keep both** (`resolveMerge`) in the conflict banner, and word it honestly ("another Runway
   tab or another program changed todo.md").
4. Or the blunt tool: `navigator.locks.request("runway-writer", { ifAvailable: true })` at boot; a tab
   that does not get the lock shows "This list is open in another tab" and stays read-only.

### R2 · High · Files that are not UTF-8 — ✅ fixed in v1.3.0

**What happens.** `Persist.readText` decodes with a non-fatal `TextDecoder`. A Latin-1/Windows-1252
file (Notepad "ANSI", many older editors) decodes with `U+FFFD` for every accented byte; the app shows
`Caf� cr�me`, connects without a word, and the first save writes the whole file back as UTF-8 with the
replacement characters baked in — headings and prose included (S6a/b). A UTF-16 file (Notepad "Unicode")
decodes to NUL-laced garbage with zero tasks; because task-less files connect silently, a browser that
already has tasks then *appends* its sections to that garbage and writes it (G9). A binary file chosen
by mistake takes the same path. Both violate the README's "preserved byte-for-byte, forever".

**Fix.** Decode with `{ fatal: true, ignoreBOM: true }`. On failure (or a `FF FE`/`FE FF` BOM, or NULs
in the first KB), refuse: show a banner *"todo.md is not UTF-8 text — Runway will not write to it"*,
keep the handle but treat the connection as read-only (never set `dirty`, never `flush`), and offer
"Choose another file". Apply the same check to **Import .md** and to backup restore. A conversion
("Convert to UTF-8 and continue") is fine as an explicit button; never implicit.

### R3 · Medium · One bad stored record breaks three views, silently — ✅ fixed in v1.3.0

**What happens.** `Model.validate` checks `due` and every sub-task `due` with `validISO`, but accepts
any truthy `doneAt` and any `createdAt`/`updatedAt`. Seed one record `{done:true, doneAt:"garbage"}`
(S1) or `doneAt: true` (F2): boot works (the completed section is not rendered until asked for), the
quarantine banner does not appear, and then clicking **✓ N this week**, opening **Stats**, or searching
`is:done` throws `TypeError … getDay` inside `Util.fmtLong`/`parseISO`. `render()` has already emptied
the list root, so the completed list is blank, the stats panel never appears, `is:done` shows nothing,
and every later render dies at the same line — new tasks still reach IndexedDB but the header counts,
tag chips and title stop updating (S1e). There is no error banner and no `window.onerror`/
`unhandledrejection` handler anywhere. Garbage `createdAt` yields `NaN` ages in stats (F3).

**Fix.** In `validate`: `if (t.done && !Util.validISO(t.doneAt)) → quarantine` (or repair to today and
mark the record), and coerce `createdAt`/`updatedAt` to valid ISO timestamps (`isNaN(Date.parse(x))` →
now). Make `fmtLong`/`fmtShort` return the raw string when `parseISO` fails. Wrap `Render.render()` in a
guard that shows *"Runway hit an error while drawing the list — your data is intact; export or
reload"* and log the error; add `error`/`unhandledrejection` listeners that raise the same banner.
A quarantine promise the README already makes should cover every field, not just `due`.

### R4 · Low · Malformed id repaired in memory only

`validate` replaces an id that does not match `[0-9a-z]{6}` with a fresh one, but `Model.load` never
writes the repaired record back or deletes the old key. The first edit commits under the new id, so
IndexedDB now holds both; the next load shows two tasks (S13). Fix: in `load`, when `validate` changed
`t.id`, `putAll([t], [oldId])`; or quarantine instead of repairing.

### R5 · Medium · Metadata-looking text is re-interpreted on the next load — ✅ fixed in v1.3.0

**What happens.** The entry field understands `#tag`, `[d]` and `!!` and strips them into metadata, but
not `📅 2026-01-01`, `✅ …`, `⏫/🔼/🔽`, `[due:: …]`, `[priority:: …]` or `[completion:: …]` — those stay in
the title and are written into the line before the real metadata. The file parser takes the *first*
occurrence of each token, so on the next load a title "Watch 📅 2026-01-01 movie" with due 2026-09-10
becomes "Watch movie 📅 2026-09-10" **due 2026-01-01** (G4); "Rotate ⏫ certs" becomes high priority
(G5); a sub-task typed as "call 📅 2026-01-01 bob" becomes "call bob" with a date (G6). In the fuzz
corpus 40–45 % of tasks carrying such tokens changed in at least one field (B, token-hazard tier),
while 100 % of plain-word tasks round-tripped. Realistic vectors: pasting from Obsidian, emoji typed
from another app, a sub-task the user *wants* dated (the sub-task adder does not parse dates today, so
the behaviour flips after a reload).

**Fix.** Make the entry side agree with the file side: extend `EntryParse.parse` (and the sub-task
adder) to treat the same tokens as metadata that `MD.extractBody` does — show them as chips exactly
like tags and priority already are. Then the file never sees metadata syntax inside free text.
Optionally also parse app-written lines from the tail (the app always emits metadata last), which
protects hand-written lines with a date in the middle of a sentence.

### R6 · Medium · IME composition Enter — ✅ fixed in v1.3.0

`Entry.init`, the title editor, both date editors and the sub-task add/edit inputs all act on
`keydown` `Enter` without checking `e.isComposing` (or `keyCode === 229`). Chromium, Firefox and Safari all
deliver the Enter that *confirms* a composition as a keydown with `isComposing: true`; the app adds the
task with whatever the box holds and clears it (S3). Fix: `if (e.isComposing || e.keyCode === 229) return;`
at the top of each Enter branch — six sites.

### R7 · Medium · Undo history spans a model replacement — ✅ fixed in v1.3.0

The journal is designed to survive reloads (README: "survives reloads"), and `adopt()` — external
reload, first connect, import, restore — replaces the model without touching it. After an external
edit is auto-loaded, Ctrl+Z replays the last pre-reload entry: undoing an "add" deletes the task the
external editor just renamed and filled with notes, and the deletion is written to the file (S12).
Fix: call `Undo.reset()` and clear the `journal` store in `adopt()` (or append a barrier record that
`undo`/`redo` refuse to cross). A persisted journal is only safe across reloads of the *same* model.

### R17 · High (hostile input) · Quadratic parser regexes — ✅ fixed in v1.3.0

Two patterns backtrack quadratically on adversarial whitespace or unclosed fields, so a single long
line freezes the tab. `TASK_RE = /^([-*])\s*\[( |x|X)\]\s+(.*\S.*)$/` — the body group `(.*\S.*)` makes
the engine try every split of a run of trailing spaces looking for a trailing non-space. `\[\s*due::\s*([^\]]*)\]`
(and its sub-task twin) does the same across thousands of unclosed `[due:: ` starts. The same
`.*\S.*`-style backtracking sits in the `## ` heading match and in the serialiser's stale-id trim.

Measured on the v1.2.1 code:

| Input | Parse (v1.2.1) | Parse (v1.3.0) |
|---|---:|---:|
| `- [ ]` + 40,000 trailing spaces | 1.5 s | < 1 ms |
| `- [ ]` + 320,000 spaces (extrapolates to ~90 s at 300 KB pre-fix) | ~90 s | 1.6 ms |
| task line with 8,000 unclosed `[due:: ` | 0.7 s | 4 ms |
| serialise an id-less line with 40,000 internal spaces | 1.3 s | 0.3 ms |

Reachable through **Import**, a **synced `todo.md`** written by another tool, or a **backup restore** —
no attacker needed, just a pathological line. Nothing is lost; the tab is unresponsive until the parse
finishes. **Fix (applied):** the task body group is `(\S.*)` — a leading non-space then anything, which
captures exactly the same text with no backtracking; `[key:: value]` fields are found by matching the
key and then `indexOf("]")` (`bracketFields`, O(n)); the heading is matched with two `charCodeAt`
checks and `trim()`; the serialiser trims with `trimEnd()`. A differential test over 300,000 random
strings confirms the rewrites capture byte-identically, and the embedded suite asserts every case stays
under a fixed budget.

### R8 · Low · Space on a focused button

`Keys.handler` exempts checkboxes from the Space shortcut but not buttons. Select a task with `j`, Tab
to its Snooze button, press Space: the task is completed instead (S4). Enter works because it is not a
shortcut. Fix: return early when `e.target.closest("button, a, [role=menuitem]")` for `" "` (and leave
Enter alone).

### R9 · Low · Double Enter

`Entry.commit` awaits the add before clearing the box, so a second Enter in that window re-reads the
same text (S5) — a held key with auto-repeat, or a bouncing switch, does this. Fix: a `committing`
flag around the body (same for the sub-task adder).

### R10 · Low · `[constructor]` and `[__proto__]` are tag shortcuts

`EntryParse.parse` and `MD.extractBody` look shortcuts up with `tagMap[k.toLowerCase()]`, so any
all-lowercase inherited property name matches: the bracket word is removed from the title and a
function (or `Object.prototype`) is pushed into `tags` (G1, G2; 1,246 of 8,000 fuzzed entries, D2/D3).
`validate` later drops the non-string tag, so the visible effect is a word silently vanishing from the
title and a `function Object() …` chip in the entry preview. Fix: `Object.prototype.hasOwnProperty.call(tagMap, key)`,
or build the map with `Object.create(null)`.

### R11 · Low · Tag labels with `_` or `#`

The file encodes spaces in tags as `_` and decodes `_` as a space, and a label may itself contain `_`
or `#` (settings accept anything). `snake_case` comes back as "snake case", `C#` as tag `C` with a `#`
left in the title, a label starting with `#` never matches again (B, tag-hazard tier: ~77 % of such
tasks changed). Fix: normalise labels when saved (`_` → space, strip `#`), and say so in the settings
hint.

### R12 · Low · Settings import of a non-object resets everything

`sanitize(raw)` returns defaults for a non-object and the import handler applies them without looking
at the `corrupt` flag (S7b). A file containing `null` or a stray string wipes theme, tag keys, work
week and thresholds with no message. Fix: refuse non-objects (and objects with no known key) with the
existing "couldn't be read" banner; surface the `corrupt` count when some keys were dropped.

### R13 · Low · Unicode line separators

`text.split(/\r\n|\n|\r/)` keeps U+2028/U+2029 inside a line, but `.` in `TASK_RE`/`CONT_RE` does not
match them, so the regexes fail: a task line containing one becomes an unrecognised raw line (the task
disappears from the app, and because it is not "a task with a bad field" it is not reported in the
problems banner either — G16); a sub-task or note line containing one drops out of its task (G17). The
entry field collapses these characters, so only pasted/imported text is affected. Fix: normalise
`[]` to a space (or split on them) before parsing.

### R14 · Low · Byte-preservation edges

- A completed line with no `✅` date gets `doneAt = today` at parse time and that value goes into the
  block fingerprint; on a later day the fingerprint no longer matches the stored task, so the first
  save rewrites the line with the synthetic date (G10). Fix: keep `doneAt` null for such lines (render
  "done" without a date) or exclude synthesised fields from the fingerprint.
- Appending the id to a hand-written line trims its trailing whitespace (G11; 72 of 400 fuzzed files,
  A3). Fix: drop the `replace(/\s+$/, "")`.
- Runs of whitespace (tabs, NBSP) inside hand-written titles collapse to one space on read (G15) — the
  entry field does the same, so this only affects imported text; worth a line in the README.

### R15 · Low · Years below 100

`new Date(50, 4, 12)` is 1950. `12 5 0050` resolves to 1950-05-12 (G12) and a hand-written
`📅 0050-06-01` displays as 1950 (G13). Fix: construct with `new Date(0,0,1)` + `setFullYear(y, m-1, d)`
in `parseISO`/`mkDate`, or refuse years < 1000 in the date language.

### R16 · Low · Ids off, title ends in `^token`

With *Write block IDs* unchecked, `- [ ] See block ^k9k9k9` is written for a task titled "See block
^k9k9k9"; on reload the parser (correctly, by the file's grammar) takes `^k9k9k9` as the id (G7). Fix:
when ids are off and the rendered line would end in `^[0-9a-z]{6}`, write the real `^id` anyway.

---

## Observations not demonstrated (from the code read)

- **`flush()` and `checkExternal()` can overlap** in one direction: `checkExternal` waits for
  `flushing` to clear, but `flush` does not wait for `checking`. A focus event that starts a check just
  before an autosave writes can see the app's own write as external and raise a spurious conflict
  banner (no data at risk; both choices write the same text). Gate `flush` on `checking` too.
- **mtime granularity.** External-change detection is mtime-first, hash-second. On file systems with
  coarse mtimes (FAT: 2 s), an external edit within the same tick as the app's own write is invisible
  until the next write; the hash is only consulted when the mtime differs.
- **`window.confirm` everywhere the user resolves a conflict.** A browser that suppresses dialogs
  ("prevent this page from creating additional dialogs", some kiosk/embedded contexts) makes every
  conflict button a no-op. In-banner confirmation would be sturdier.
- **No global error surface** (`onerror`/`unhandledrejection`); see R3.
- **Lenient grammar:** `-[ ] text` (no space after the bullet) is accepted as a task and gets an id,
  though CommonMark/Obsidian treat it as plain text; `## open` (lower case) is not a managed section.
  Both are defensible; worth documenting.
- **Settings shared across tabs** are last-writer-wins per whole object (R1's sibling; harmless).
- **Journal size:** each history entry stores full before/after snapshots; a task with a very large
  note multiplies that by up to 500 entries. Not a problem at sane sizes.
- **`color-mix()`** is used for the accent tint; browsers older than Chrome 111 / Safari 16.2 /
  Firefox 113 ignore it and get a transparent tint. Cosmetic.

---

## Reproduce

```sh
node stress/robust-fuzz.js --seed 1 --iters 400 --out stress/results/robust-fuzz.json   # ~40 s
node stress/tz-matrix.js [--quick]                                                       # ~2 min full
node stress/robust-browser.js [--only S2,S6] --out stress/results/robust-browser.json   # ~3 min, needs Playwright + Chromium
node test.js                                                                             # 180/180 on this branch
```

Both Node harnesses are deterministic (seeded) and run without a browser; they are cheap enough to
join `.github/workflows/test.yml`. The browser harness needs `playwright` and a Chromium; `--only`
runs a subset. A property that is green today and turns red after a change is a regression; a
`⚠ FINDING` that turns `✓` is one of the fixes above landing — the checks were written against the
intended behaviour, not the current one, so they double as acceptance tests for the fixes.
