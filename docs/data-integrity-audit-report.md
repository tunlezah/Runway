# Runway data-integrity audit — findings and fixes

**Audited:** runway.html v1.3.0 (main at `a9ca306`) · **Fixed in:** v1.3.1 (this branch) · **Date:** 2026-09-04

**Method:** a full read of the source; every commit in the history word-diffed at module level (`MD`, `Model`,
`Persist`) across the four commits that changed them; the five existing harnesses re-run as a baseline
(`node test.js` 180/180, `robust-fuzz` 25/46 with only the documented open Lows missing, `stress-node --quick`
green, `tz-matrix --quick` green, `robust-browser` 28/32 with only the documented open Lows missing); 24 parser
probes in Node and 9 persistence probes in headless Chromium with an Origin Private File System file standing
in for `todo.md` and monkey-patched `createWritable`/`getFile` to order asynchronous operations deterministically.

The question was the README's promise, not the tests: is anything in a user's `todo.md` ever destroyed, silently
altered or overwritten without an explicit choice?

## TL;DR

Eight defects, none previously known. Two were data-loss paths reachable through ordinary use, both present since
v1.0 and both in the one layer (`Persist`) that no test reached. **All eight are fixed on this branch**, each with a
regression test, and CI now gates on the persistence tests, the property fuzz and the browser harness.

| # | Severity | Finding | Fixed by |
|---|---|---|---|
| B1 | **Critical** | While the first-connect banner was still asking what to keep, typing a task, pressing Ctrl+S or hiding the tab rewrote `todo.md` from the browser's tasks and an empty layout; the file's tasks and prose were gone, and *Use the file* then loaded the destroyed file. A first read that failed transiently (file locked) led to the same write on *Retry* or on the next autosave. | `Persist` tracks whether the handle is *reconciled*; `flush()` never writes until it is. A read failure is reported as one (*file not read* chip, *Try again*), not as a save failure. `chooseFile`/`chooseFolder` no longer pre-set the dirty flag; *Save as new file* reads the picked file first and reconciles a non-empty one. |
| B2 | **High** | A change committed while an autosave was writing was marked saved: the dirty flag went false, `lastFlushAt` was stamped after the write so the boot replay missed it, and the next external-edit auto-reload deleted the change from IndexedDB. | A mutation sequence number: the write clears the dirty flag only if nothing changed while it was in flight, otherwise it stays dirty and writes again at once. `lastFlushAt` is the serialise time and the boot check uses `>=`. The two meta keys are written in one transaction with values captured at call time. At boot, a task the app has not changed since the last write is re-synced from its line when a normalisation change made them differ. |
| B3 | Medium | Importing an older export reverted every task it shared an `^id` with to the imported version and cleared undo. | `Model.mergeParsed(…, {currentWins})`: an import never reverts a task the app already has (the banner lists the ones it left alone); the import is one `bulk-add` journal entry, so Ctrl/⌘ Z undoes it. |
| B4 | Medium | Firefox/Safari: after a reload, Export dropped the imported file's headings and prose (the layout lived only in memory). | Without a connected file the text an export would produce is kept in storage on every save path and restored at boot. |
| B5 | Medium | An unreadable date token (`📅 2026-02-30`, `[due:: soon]`, `✅ 2026-02-30`) was deleted from the line the first time the task was edited in the app; a bad completion date was not even reported. | `extractBody` leaves an unreadable token in the text (as `subDue` already did) while still flagging it; bad completion dates are reported. The title editor shows the token, so the typo can be fixed in the app. |
| B6 | Low | Editing a task rewrote its whole block: notes moved before sub-tasks, nested sub-tasks flattened, indentation normalised. | Each task block carries a separate fingerprint of its continuation lines; when only the task line changed, the note and sub-task lines are written back verbatim — in place or after a section move. |
| B7 | Low | Task-looking lines inside fenced code blocks and multi-line HTML comments were claimed as tasks, given an `^id` on the first save, and rewritten when completed; a `## Open` inside a fence changed the section. | The parser passes closed ``` / ~~~ fences and `<!-- … -->` spans through as raw, without touching the section. Only a block that closes counts: an unclosed fence or comment is an ordinary line, so a stray ``` can never hide every task below it (the 50k-line stress corpus caught exactly that in a first version of the fix). |
| B8 | Low | Edges: first-connect *Keep both* silently preferred the file's version of a shared task; *Keep my version* rebuilt the layout from the banner-time snapshot; *Save as new file* wrote over a non-empty picked file blind; *Wipe local data* discarded changes the file had not received. | Banner wording states the rule; *Keep my version* re-reads the file; *Save as new file* reconciles a non-empty file; *Wipe* writes pending changes first and asks if it cannot. |

## Reproductions (before the fixes)

- **B1** — browser holds one task; connect a `todo.md` with prose and a task; the banner appears; type a task, press
  Ctrl+S, or switch tabs. Within 2.5 s the file read `# To Do` + the browser's task; the prose and the file's task
  were gone. Waiting without acting left the file intact. Same outcome when `getFile()` failed once at boot and the
  user clicked *Retry*, or added a task after the read recovered.
- **B2** — debounce 3 s, `close()` delayed 2.5 s: add A, add B during the write. 1.9 s later the indicator read clean
  with `dirtyFlag:false` and the file lacking B. Reload: B shown from IndexedDB, indicator clean, file still without
  B. External edit + focus: "changed on disk and was reloaded", B gone from IndexedDB.
- **B3** — rename `Report v1` to `Report v2 final`, import an export containing `Report v1 ^r00001`: the file and the
  app went back to v1; Ctrl+Z did nothing.
- **B4** — with the pickers absent, import a file with prose; Export kept it; reload; Export produced `# To Do` and
  the tasks only.
- **B5** — `- [ ] pay rent 📅 2026-02-30 ^aaaaaa`, tick complete → `- [x] pay rent ✅ 2026-09-03 ^aaaaaa`.
- **B6** — a parent with `intro note / sub one / detail / nested / sub two / closing note`, priority changed → all
  note lines first, then three flat sub-tasks.
- **B7** — a ```` ``` ```` block containing `- [ ] example` gained `^veqjbd` on the first save.

## Regression tests

- **Embedded suite** (`node test.js`, 200 tests; 189 of them also run in-page at `#test`):
  - B5: the three unreadable-token cases survive complete / priority / priority-and-move; a bad `✅` is reported and kept; `Model.validate` leaves a stored token alone.
  - B6: a due-date change keeps every continuation line byte-identical (2-space, 6-space, 8-space and tab indents, nested sub-task); a section move keeps them too; a sub-task change still re-renders.
  - B7: fences (backtick and tilde) and a comment block never yield tasks or problems, round-trip byte-identical, and a heading inside a fence does not change the section; an unclosed fence keeps the rest of the file raw.
  - B3: `Model.mergeParsed` keeps the current version under `currentWins` and adopts the parsed one otherwise.
  - Persistence, Node only (a fake `FileSystemFileHandle` with controllable `getFile`/`close`): nothing is written while the first-connect choice is pending, then *Keep both* writes both sides into the file's layout (B1); a failing first read is reported as a read error and never leads to a write, *Use the file* adopts without writing (B1); a change during an in-flight write keeps the dirty flag and is written next, and `lastFlushAt` precedes it (B2); boot resync adopts the file's line for an untouched stale record and leaves a changed one alone; import keeps the current version, adds the rest, and is one undo step (B3); a tier-2 import's layout is what `currentText()` reproduces (B4).
- **Browser harness** (`stress/robust-browser.js`): S14 (B1, five checks), S15 (B2, two checks), S16 (B3, two
  checks), S17 (B4). Run in CI with `--fail-on-new`, which fails only on findings beyond the documented open Lows
  (S4, S5, S7b, S13). The fuzz harness has the same flag.

## What was verified to hold

Parser and serialiser never throw and never drop an unrecognised line (fuzz A1–A6, 1M prose lines, 50k fuzz
lines, non-UTF-8 refused). Unchanged tasks and raw lines are byte-identical across saves; repeated saves are
idempotent. A failing `createWritable` leaves the file intact, raises the banner, keeps the dirty flag, and *Retry*
writes. A pending autosave survives a closed tab. External edits auto-reload when clean and raise the conflict banner
when dirty, and the conflict banner's Ctrl+S / hidden-tab paths never write. Two-tab writes self-heal or offer
*Keep both*. Undo is cleared across model replacements. Every historical fix (F1–F5, the v1.2.0 data-loss fixes,
R1–R17) still behaves as its commit describes.

## Still open (documented Lows, unchanged)

R4, R8, R9, the title-mangling half of R10, R11–R16 — see `robustness-check-report.md`. Not verified in this audit:
real-disk behaviour of `close()` failures, permission re-prompts after a browser restart, sync clients replacing the
file between `getFile()` and `close()`, FAT mtime granularity, mobile Chromium.

## Design rule carried into the fixes

When the app cannot prove what is on disk, it must not write. A banner that waits is better than a save that guesses.
