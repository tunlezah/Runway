# Runway

**A to-do list that lives in one HTML file and saves to a markdown file you own.**

[![Tests](https://github.com/tunlezah/Runway/actions/workflows/test.yml/badge.svg)](https://github.com/tunlezah/Runway/actions/workflows/test.yml)
&nbsp;Current version: **v1.3.1**

Runway is a fast, keyboard-friendly task list with due dates, tags, priorities, notes and
sub-tasks — and a runway-style view of what's landing when. It is deliberately small:

- **One file, no install.** The whole app is `runway.html`. Open it in a browser and it works.
- **Your tasks are a plain markdown file** (`todo.md`) on your own disk. You can read it, edit
  it in any text editor or in Obsidian, grep it, back it up, and put it in Dropbox or git.
  There is no database you can't see.
- **No account, no server, no tracking.** The page never talks to the network — its security
  policy (`connect-src 'none'`) forbids it. Everything happens on your machine.
- **It respects your file.** Anything in the file the app doesn't recognise — headings, prose,
  notes to yourself — is preserved byte-for-byte, forever. Lines it can't read are reported,
  never altered or deleted.

---

## Getting started

1. **Open the app.**
   - Easiest: open the copy published from `main` — `https://tunlezah.github.io/runway/`
     (if that 404s, check the repository's *Settings → Pages* for the exact URL), **or**
   - download `runway.html` from this repository and double-click it. It works from disk.
2. **Type a task** in the *"What needs doing?"* box and press <kbd>Enter</kbd>. Put a date in
   the *"When?"* box first if it has a deadline — see [date language](#the-date-language) below.
3. **Connect your markdown file.** Click **⊕ Choose todo.md** in the header (or *Settings →
   File*). Pick an existing `todo.md` or create a new one. From then on every change autosaves
   to that file, about a second after you stop typing. If the browser already holds tasks *and*
   the file you pick has some too, Runway asks what to do — **Keep both**, **Use the file**, or
   **Use browser tasks** — and shows the difference; the file's headings and notes are kept
   whichever you choose.

**Browsers:** direct file saving uses the File System Access API, which exists in
Chrome, Edge, Brave, Arc and other Chromium browsers. In Firefox and Safari the app still
works fully, but stores tasks in the browser instead — use **Export .md** / **Import .md**
(*Settings → File*) to move the markdown file in and out. The header always shows where your
data currently lives; a warning chip appears if it's browser-only.

> **Tip:** the app is happiest pinned as a browser tab. The tab title shows a live count of
> overdue + due-today items, e.g. `(3) Runway`.

---

## Everyday use

### Adding tasks

Everything can be typed in one line. The title box understands:

| You type | What happens |
|---|---|
| `Chase the vendor invoice` | plain task |
| `Patch the jump host #Highside` | adds the tag `Highside` (any `#tag`; use `_` for spaces) |
| `Email frank [d]` | tag shortcut — `[d]` becomes your mapped tag (editable in *Settings → Tags*) |
| `Rotate the certs !!` | priority: `!` low · `!!` medium · `!!!` high |
| `Renew the cert 📅 2027-05-12` | a `📅` date, `⏫`/`🔼`/`🔽` priority, or a `[due:: …]` / `[priority:: …]` field typed in the title is understood too |
| `Patch the box #C_sharp` | tag labels can't contain `#` (it starts a new tag); a `#` in a label is dropped, and `_` shows as a space |

Live chips under the box show the tags, priority and date it detected. The same tokens the file
uses (`📅`, `✅`, priority emoji, `[key:: value]`) are recognised in the title so that whatever you
type is stored as real metadata — it is never left in the title to be re-read differently later. The
date goes in the second box; press <kbd>Enter</kbd> in either field to add. Press <kbd>Shift+Enter</kbd>
to keep a past date literal instead of rolling it forward.

**Paste a list:** paste multiple lines into the title box and Runway offers to add them as one
task per line (tags and `!` priorities are parsed per line; the date field, if set, applies to
all of them).

### The date language

The *"When?"* box (and every date editor in the app) accepts quick phrases. A preview under
the entry row shows exactly what it resolved to before you commit.

| Input | Meaning |
|---|---|
| `today` / `tod`, `tomorrow` / `tom` / `tmw` | what it says |
| `fri`, `tue`, `monday`… | the next such weekday |
| `eow` | end of week (in work-day mode: your last work day) |
| `eom` | last day of this month |
| `+3` or `+3d` | in 3 days |
| `+2w` | in 2 weeks |
| `+1m` | in 1 month (clamps: 31 Jan `+1m` → 28 Feb) |
| `+3b` | in 3 **work days** (uses your work-week setting) |
| `6 9`, `6/9`, `6.9` | day month → 6 September (this year, or next if that's already past) |
| `12 5 27` | 12 May 2027 |
| `2026-9-6`, `2026/9/6` | year-first also fine |

Dates you type without a year **roll forward**: if "12 5" has already passed this year, you
get 12 May next year. The preview says "rolled forward" when this happens;
<kbd>Shift+Enter</kbd> (or turning off *Settings → Dates → Roll past dates forward*) keeps
the literal date. Impossible dates are refused with a reason ("31 April doesn't exist",
"2027 isn't a leap year") rather than silently corrected.

**Calendar vs work days:** in *Settings → Dates* you can count gaps in calendar days (default)
or in **work days**, with your own work week (any set of days — Mon–Fri, Sun–Thu, whatever).
In work-day mode the chips read "in 3 wd", "Tomorrow" becomes "Next work day", and urgency
colours ignore your days off.

### Reading the list

Open tasks are grouped into **Overdue · Today · Tomorrow · This week · Later · No date**, each
row carrying a small 4-segment gauge and a colour that ramps as the deadline approaches:

- **calm** (green) — more than 14 days out
- **soon** (yellow) — within 14 days
- **near** (orange) — within 5 days
- **due** (red) — today
- **overdue** (red, marked edge) — past due

The thresholds are yours to change (*Settings → Urgency*, with a live preview). If a task's
**sub-task** is due earlier than the task itself, the earlier date drives the colour — the
`2/5`-style sub-task counter turns coloured to tell you that's happening.

Above the list, a **runway timeline** shows the next four weeks as columns of dots (one per
task, coloured by urgency, with a "late" column on the left). Click a dot to jump to its task.
The filter row under the header holds the tag chips (keyboard <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>,
<kbd>0</kbd> clears) and the search field (<kbd>/</kbd>); while the list is narrowed its count reads
"showing N of M". A digest bar summarises "N overdue · M due today" until you dismiss it.

### Working a task

Hover (or select with <kbd>j</kbd>/<kbd>k</kbd>) to reveal row actions:

- **Complete** — tick the checkbox (or <kbd>x</kbd>/<kbd>Space</kbd>). A toast offers **Undo**
  for a few seconds (window configurable). Completed tasks move to the file's `## Completed`
  section with a completion date.
- **Rename** (<kbd>e</kbd>), **edit the date** (<kbd>d</kbd>) — click the title or date chip.
- **Snooze** (<kbd>.</kbd>) — a one-keystroke menu: tomorrow / +3 days / next week / next
  month / remove date (work-day variants in work-day mode). Press <kbd>1</kbd>–<kbd>5</kbd>
  inside the menu.
- **Priority** (<kbd>!</kbd>) — cycles none → `!` → `!!` → `!!!`.
- **Sub-tasks & notes** (<kbd>s</kbd> to add) — each task can carry free-text note lines and a
  checklist of sub-tasks; sub-tasks can have their own due dates, be reordered, renamed and
  deleted. They stay collapsed behind the `2/5` counter until you expand them, so big
  checklists don't clutter the list.
- **Delete** — the bin icon; a toast offers Undo.

Undo/redo covers everything (<kbd>Ctrl/⌘ Z</kbd>, <kbd>Ctrl/⌘ ⇧ Z</kbd>), with a journal of
your last 500 actions that survives reloads.

### Search and filters

Press <kbd>/</kbd> and type. Free text matches fuzzily against title, tags and notes. These
operators narrow further (combine freely; prefix any token with `-` to negate):

| Query | Matches |
|---|---|
| `#high` | tags starting with "high" |
| `!!` | priority ≥ medium (`!!!` = high only) |
| `overdue`, `today`, `week` | by effective due date |
| `due:<7d` / `due:>30d` | due within / beyond N days |
| `due:<2026-12-01` / `due:>2026-12-01` | before / after a date |
| `is:undated` | no due date |
| `has:note` | has a note or sub-tasks |
| `is:done` | search **completed** tasks instead (the full history, not just recent) |
| `-#home`, `-overdue` | exclude |

### Views

Cycle with <kbd>v</kbd> or the header switcher:

- **List** — the default, everything above.
- **Board** — columns for Overdue / Today / Tomorrow / This week / Later / No date.
  **Drag a card to a column to reschedule it** (dropping on "Tomorrow" sets tomorrow's date,
  "No date" clears it, and so on — work-day aware).
- **Calendar** — a month grid with tasks as chips (three per day, "+N more" expands). Click a
  chip for actions, click a day number to start a new task pre-filled with that date.

### Completed history and stats

The header shows **✓ N this week** — click it to reveal recently completed tasks grouped by
day (window configurable, default 7 days; the view lists at most the latest 200 — search
`is:done` to dig further back). Reopen anything with its checkbox.

The **stats panel** (bar-chart button) gives you: completed today / this week vs last, your
busiest day, an 8-week throughput chart, a 14-day forecast of what's due (overloaded days
flagged), and list health — open count, overdue count, average and oldest age, stale tasks
untouched for 30+ days, and how much of the list is undated.

### Keyboard shortcuts

Press <kbd>?</kbd> anytime for this list in-app.

| | |
|---|---|
| **Navigate** | <kbd>j</kbd>/<kbd>↓</kbd> next · <kbd>k</kbd>/<kbd>↑</kbd> previous · <kbd>v</kbd> cycle view · <kbd>Esc</kbd> close/clear/deselect |
| **Act** | <kbd>x</kbd>/<kbd>Space</kbd> complete · <kbd>e</kbd> rename · <kbd>d</kbd> edit date · <kbd>s</kbd> add sub-task · <kbd>.</kbd> snooze · <kbd>!</kbd> priority · <kbd>n</kbd> new task |
| **Filter** | <kbd>/</kbd> search · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> tag filters · <kbd>0</kbd> clear |
| **Entry** | <kbd>Enter</kbd> add · <kbd>Shift+Enter</kbd> add with literal date · <kbd>Tab</kbd> title → date |
| **System** | <kbd>Ctrl/⌘ Z</kbd> undo · <kbd>Ctrl/⌘ ⇧ Z</kbd> redo · <kbd>Ctrl/⌘ S</kbd> save now · <kbd>?</kbd> help |

### Appearance

*Settings → Appearance*: light / dark / follow system, six accent colours, comfortable or
compact row density — and a **GeoCities** theme for people who miss 1998. Settings can be
exported and imported as JSON.

---

## Your file, your data

### What todo.md looks like

```markdown
# To Do
<!-- Runway v1 · edit freely; the app preserves anything it does not recognise -->

## Open
- [ ] Send an email to frank #DPN 📅 2027-05-12 ^k3f9qm
- [ ] Patch the jump host #Highside ⏫ 📅 2026-08-26 ^a7b2xd
    Needs change approval before the window opens.
    - [ ] raise CR 📅 2026-08-20
    - [x] schedule window

## Reference
Some prose the app must never touch. It won't.

## No date
- [ ] Buy vinyl inner sleeves ^q8w3ez

## Completed
- [x] Replace the failing SSD #Highside ✅ 2026-08-18 ^z1x4cv
```

- Runway manages three sections — `## Open`, `## No date`, `## Completed` — and moves tasks
  between them as you date/complete them. **Everything else in the file is preserved exactly**,
  including whole unrelated sections, and unchanged tasks are written back byte-identical.
- Metadata style is **emoji** (`📅` due, `✅` done, `🔽🔼⏫` priority — the same convention as
  the Obsidian Tasks plugin) or **bracket** (`[due:: 2026-09-10]`, `[priority:: high]`,
  `[completion:: …]`) — pick in *Settings → Markdown*; both are always understood when reading.
- The trailing `^k3f9qm` is the task's **id** (Obsidian block-reference syntax, always the last
  thing on the line). It's how the app tracks a task across edits and file syncs. Leave ids
  alone when hand-editing; everything else on the line is fair game. Tasks you add by hand
  get an id automatically on the next save; duplicate ids are detected and reassigned safely.
- Tags are `#Words_With_Underscores` in the file and display with spaces in the app.

**Hand-editing is a supported workflow.** Edit in Obsidian, vim, or Notepad while the app is
closed — or even while it's open: Runway checks the file when you return to the tab. If only
the file changed, it reloads it and tells you; if both sides changed, it shows a conflict banner
with a line-by-line diff and an explicit choice (*Reload from disk* / *Keep my version* — the
latter overwrites the file's *tasks* but keeps its headings, notes and anything else). **Nothing
is ever merged or overwritten silently.** Lines it can't read (say, a task with `📅 2026-02-31`)
are flagged in a banner, treated as undated, and kept in the file exactly as written — the only
thing Runway ever adds to a hand-written line is its `^id`.

### Saving, backups and safety nets

- **Autosave** writes the whole file ~0.8 s after each change (configurable 0.1–60 s). The
  header dot shows the state: grey = saved, amber = writing/unsaved, red = a save failed
  (with a Retry chip). <kbd>Ctrl/⌘ S</kbd> forces a save.
- **A browser-storage mirror** (IndexedDB) is updated on *every single change*, before the
  file write. If your machine dies mid-save, or a save fails, nothing is lost — the app
  replays the unsaved state next launch. File writes themselves are atomic (temp file + swap),
  so a crash can't leave `todo.md` half-written.
- **Folder mode** (*Settings → File*, Chromium only): point Runway at a folder instead of a
  file and it keeps `todo.md` **plus timestamped backups** in `backups/` after every save —
  keeping the newest 20 by default (5–100). A restore list with task counts is built into
  Settings; restoring shows a diff and asks before it writes the backup over `todo.md`.
- **Export / Import** works everywhere, any browser. Importing into a connected file adds the
  imported tasks; the connected file keeps its own headings and notes.
- **Wipe local data** (*Settings → Advanced*, type `wipe` to confirm) clears the browser copy,
  settings and undo history. The markdown file on disk is never touched by a wipe.

### Syncing between machines

Put `todo.md` in Dropbox/Syncthing/iCloud Drive/git and point each machine's Runway at it.
The mtime + content-hash conflict check catches simultaneous edits and makes you choose, so
the worst case is a visible conflict banner, not silent loss. Best practice is still: one
machine actively writing at a time, and folder mode's backups on if you want belt-and-braces.
The same goes for browser tabs: keep the list open in **one tab** per machine — two tabs on the
same list can raise that conflict banner against each other, and the choices it offers each drop one
tab's work (see finding R1 in [`docs/robustness-check-report.md`](docs/robustness-check-report.md)).

### Privacy

The app makes no network requests at all (enforced by its own Content-Security-Policy).
One caveat worth knowing, straight from the app's settings screen: every page opened from
`file://` shares one browser storage origin, so *other local HTML files opened in the same
browser* could technically read Runway's stored tasks. If you routinely open untrusted local
HTML, serve Runway from `localhost` or use the hosted copy — both give it an isolated origin.

---

## How much can it handle?

We stress-tested the exact code in this repository — the parser/serialiser in Node and the
full UI in Chromium — up to 200,000 tasks. Full method and raw numbers:
[`docs/stress-test-report.md`](docs/stress-test-report.md) (harnesses in [`stress/`](stress/)).
Times below were measured on a 2.8 GHz machine; treat them as ±2× on your hardware.
Two numbers matter, and they're different:

### 1. Open tasks — what the list renders

The app redraws the whole visible list after every action, so **open** items set the feel:

| Open tasks | Feel |
|---:|---|
| **≤ 500** | **Comfortable.** Everything under ¼ s. This is the design zone. |
| ~1,000–2,000 | Sluggish: 0.3–1.6 s freeze per complete/add. Usable, annoying. |
| ~5,000 | Painful: 2–4 s per action. |
| ~10,000+ | Effectively unusable: 6 s to nearly a minute per action at 50k. |

Completed tasks and collapsed sub-tasks **don't count** toward this — a 20,000-item file with
1,000 open behaves exactly like a 1,000-item list. Realistically, if you keep an open list a
human can actually work (dozens to a few hundred items), the UI never gets in your way.

### 2. Total items in the file — what every load and save costs

Every item in the file (completed included) is parsed on load and rewritten on save:

| Items in file | File size | Feel |
|---:|---:|---|
| **≤ 5,000** | ~430 KB | **Comfortable** — loads and saves are imperceptible (≤ 0.1 s). |
| ~20,000 | ~1.7 MB | Fine, with a noticeable ~0.3 s pause per autosave. |
| ~50,000 | ~4.3 MB | Saves ~0.8 s, load parse ~0.6 s. Works, feels heavy. |
| ~200,000 | ~17 MB | Still correct (verified byte-identical round-trips), but ~5 s per save. |

**Sub-tasks:** effectively free at sane counts. A task with hundreds of sub-tasks is fine;
even 10,000 lines under one task parses in ~30 ms, and 250,000 sub-tasks across a file still
round-trips correctly. Collapsed sub-tasks cost the UI nothing.

**Reliability is not the thing that degrades.** At every scale tested, files round-tripped
**byte-for-byte identical** — no gradual corruption, no lost fields. The stress test did find
five defects (a serialiser crash at ~125k lines in one entry, a rare id-collision data-loss
path on huge id-less imports, and three smaller issues) — **all five are fixed as of v1.1.1**,
with regression tests. Details in the report.

### Practical guidance

- **Keep the *open* list human-sized** (≤ a few hundred). That's the only number you'll feel
  day-to-day, and it's a workload problem before it's ever a software problem.
- **Let Completed grow for a year or two without worrying.** At ~30 completions/day the file
  grows roughly 11,000 items (~1 MB) per year — year one is imperceptible, year two or three
  crosses into "noticeable save pause" territory.
- **Archive old completed items once the file passes ~5,000 items / ~1 MB.** Until a built-in
  archive button exists, it's a safe two-minute manual job, precisely *because* the file is
  plain markdown:
  1. Close the app tab (or just make sure the save dot is grey/idle).
  2. Open `todo.md` in any editor. Cut old entries out of `## Completed` (each is one
     `- [x] …` line) and paste them into a new file like `todo-archive-2026.md` next to it.
  3. Save; reopen Runway. It reads the smaller file — and the archive stays valid
     Runway/Obsidian markdown you can open in any editor whenever you need the history.
  Archiving items older than ~90 days never changes the stats panel — it only looks back
  8 weeks.
- **Importing a huge hand-written list?** Prefer files whose tasks already carry `^ids` if
  they came from another Runway file. Id-less imports are fine too (collision handling was
  hardened in v1.1.1); very large imports simply take a few seconds to land in browser storage.

---

## Troubleshooting

| You see | It means | Do |
|---|---|---|
| **"⊕ Choose todo.md"** chip | Tasks aren't connected to a file yet | Click it and pick/create your file |
| **"not saved to file"** warning chip | You have tasks but no file connection | Same as above — until then they live in this browser only |
| **"Runway needs permission again…"** | The browser dropped file permission (happens after restarts) | Click **Reconnect** — one click restores it |
| **"todo.md changed on disk and was reloaded"** | The file was edited elsewhere and you had nothing unsaved | Nothing to do — the app now shows the file's version |
| **"todo.md changed outside this app while you had unsaved changes"** | Both sides changed | Use **Show what changed**, then *Reload from disk* or *Keep my version* — nothing merges silently |
| **"todo.md already has N tasks, and this browser has M tasks…"** | You connected a file while the browser already held tasks | **Keep both** merges them; the other two buttons say exactly what they drop |
| **"Couldn't write todo.md…"** + red dot | A save failed (drive unplugged, file locked…) | Your data is safe in the browser; fix the cause and hit **Retry** |
| **"todo.md is no longer at that location"** | File moved/renamed/deleted | **Choose file** to re-point, or **Save as new file** |
| **"N lines couldn't be read as tasks"** | e.g. an invalid date typed by hand | Click **Show lines**; fix them in the file or in the app — the lines were preserved as-is |
| **"todo.md isn't UTF-8 text"** | The file is Latin-1/ANSI, UTF-16, or binary — Runway won't write to it | Re-save it as UTF-8 in your editor, then click **Check again**, or **Choose file** to pick another. Your tasks stay safe in the browser meanwhile |
| **"Browser storage is full"** | The browser's quota is exhausted | Export your file, archive old completed items, or free site storage |
| **"This browser can't save directly to a file"** | Firefox/Safari (no File System Access API) | Use **Export .md** to keep `todo.md` current, or use a Chromium browser |
| **"Storage is unavailable in this browser session"** | Private windows in some browsers | Tasks last until the tab closes — **Export** before leaving |
| **"stored task record(s) couldn't be validated"** | Corrupt browser records were found | They're quarantined, not deleted; your file is unaffected |
| **"Some saved settings couldn't be read"** | Settings got corrupted | They reset to defaults; tasks untouched |

Still stuck? Open the app with `#test` appended to the URL to run its built-in self-test
panel (162 checks) — a clean pass rules out the app's own logic.

---

## For developers

- Everything is in `runway.html` — no dependencies, no build. CSS at the top, JS between
  `/*JS-START*/ … /*JS-END*/` markers.
- `node test.js` runs the same 162-test suite the browser runs at `#test` (CI runs it on
  every push).
- `stress/` contains the load-test harnesses behind the numbers above:
  `node --expose-gc stress/stress-node.js` (parser/serialiser limits + robustness corpus) and
  `node stress/stress-dom.js` (headless-Chromium UI measurements). See
  [`stress/README.md`](stress/README.md) and [`docs/stress-test-report.md`](docs/stress-test-report.md).
- The robustness check (v1.2.1 → fixes in v1.3.0 and v1.3.1) lives next to it: `node stress/robust-fuzz.js` (property-based
  checks on the parsers and record validation), `node stress/tz-matrix.js` (every day of 2024–2027 in
  31 time zones) and `node stress/robust-browser.js` (failure injection against the live UI — two tabs,
  corrupt storage, IME, non-UTF-8 files, unload mid-save…). Findings, severities and proposed fixes:
  [`docs/robustness-check-report.md`](docs/robustness-check-report.md).
- Pushes to `main` deploy the app to GitHub Pages via `.github/workflows/pages.yml`.
