#!/usr/bin/env node
/* robust-fuzz.js — property-based robustness checks for Runway's pure engine.

   Runs against the real code inside runway.html (extracted the same way test.js does).
   Nothing is mocked except the input generators.

     A  markdown file fuzz     random files → parse never throws; serialise(parse(x)) preserves
                               every byte except the ^ids the app is allowed to append; a second
                               cycle is idempotent; the re-parse sees the same tasks
     B  model round-trip       random task objects → file → model must reproduce every field,
                               for emoji/bracket metadata and with/without ^ids
     C  date language fuzz     random strings never throw; resolved dates are valid and sane
     D  entry parser fuzz      never throws; every tag is a string; bracket words survive
                               unless they are a configured shortcut
     E  search query fuzz      never throws on any query against any task
     F  hostile stored records Model.validate never throws; records it accepts must not break
                               the helpers the renderer calls on them
     G  named probes           reproducible single cases behind the findings in
                               docs/robustness-check-report.md

   Usage: node stress/robust-fuzz.js [--seed N] [--iters N] [--out results.json]
   Symbols: ✓ property held · ⚠ FINDING property violated (a defect) · ✗ harness error
*/
"use strict";
const fs = require("fs");
const path = require("path");

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const SEED = +arg("--seed", 1);
const ITERS = +arg("--iters", 400);
const OUT = arg("--out", null);

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, "..", "runway.html"), "utf8");
  const m = /\/\*JS-START\*\/([\s\S]*?)\/\*JS-END\*\//.exec(html);
  if (!m) throw new Error("JS markers not found");
  const mod = { exports: {} };
  new Function("module", "exports", m[1])(mod, mod.exports);
  return mod.exports;
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const results = { meta: { seed: SEED, iters: ITERS, date: new Date().toISOString() }, checks: [] };
let findings = 0;
const report = (name, ok, detail, finding) => {
  const sym = ok ? "✓" : finding ? "⚠ FINDING" : "✗";
  if (!ok && finding) findings++;
  console.log("  " + sym + " " + name + (detail ? " — " + detail : ""));
  results.checks.push({ name, ok, finding: !ok && !!finding, detail: detail || "" });
};

/* ---------------- generators ---------------- */
const WORDS = "patch review deploy rotate audit backup restore triage verify sign scan build test merge renew invoice schedule brief firewall sensor endpoint kernel registry cluster tunnel parser sandbox payload console token cert vault café naïve Ünïcödé 日本語 emoji😀 zwj👩‍💻 rtlעברית combininǵ tab\tsep nbsp x ls x".split(" ");
const HAZARDS = ["📅 2026-01-01", "📅 2026-02-30", "✅ 2026-01-01", "⏫", "🔼", "🔽", "[due:: 2026-01-01]", "[priority:: high]", "[completion:: 2026-01-01]", "#tag", "#Two_Words", "[d]", "[constructor]", "[__proto__]", "!!", "!!!", "^abcdef", "^k9k9k9", "- [ ] inner", "## Open", "<!-- c -->", "  ", "\t"];
const TAGS = ["DPN", "BSM", "Highside", "Two Words", "snake_case", "ünï", "C#", "a-b", "x"];
const isoRand = () => { const y = int(2024, 2030), m = int(1, 12), d = int(1, 28); return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"); };
const words = (n, hazardP) => { const out = []; for (let i = 0; i < n; i++) out.push(chance(hazardP || 0) ? pick(HAZARDS) : pick(WORDS)); return out.join(" "); };

let idCounter = 0;
const idOf = (n) => n.toString(36).padStart(6, "0").slice(-6);
const freshId = () => idOf(++idCounter);

function genTaskLine(withId) {
  const done = chance(0.3);
  const bullet = chance(0.9) ? "-" : "*";
  const box = done ? (chance(0.8) ? "x" : "X") : " ";
  const parts = [words(int(1, 5), 0.15)];
  const meta = [];
  if (chance(0.6)) meta.push(chance(0.85) ? "📅 " + isoRand() : chance(0.5) ? "📅 2026-02-30" : "[due:: " + isoRand() + "]");
  if (done && chance(0.7)) meta.push(chance(0.8) ? "✅ " + isoRand() : "[completion:: " + isoRand() + "]");
  if (chance(0.3)) meta.push(pick(["⏫", "🔼", "🔽", "[priority:: high]", "[priority:: low]", "[priority:: med]"]));
  if (chance(0.4)) meta.push("#" + pick(TAGS).replace(/ /g, "_"));
  if (chance(0.15)) meta.push("[" + pick(["d", "b", "t", "zz", "constructor"]) + "]");
  // metadata in random order, sometimes mixed into the title
  while (meta.length) { const i = Math.floor(rnd() * meta.length); parts.push(meta.splice(i, 1)[0]); }
  if (chance(0.2)) parts.reverse();
  let line = bullet + " [" + box + "] " + parts.join(" ");
  if (withId) line += " ^" + freshId();
  if (chance(0.05)) line += "  "; // trailing whitespace
  return line;
}
function genContinuation() {
  const ind = pick(["    ", "  ", "\t", "      ", "        "]);
  const r = rnd();
  if (r < 0.45) return ind + words(int(1, 6), 0.1);
  if (r < 0.9) return ind + "- [" + (chance(0.5) ? "x" : " ") + "] " + words(int(1, 4), 0.1) + (chance(0.4) ? " 📅 " + isoRand() : "");
  if (r < 0.95) return ind + ind + "- [ ] " + words(2); // nested deeper
  return ind; // whitespace-only line
}
function genFile() {
  const lines = [];
  const n = int(1, 40);
  let allIds = true;
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.08) lines.push("## " + pick(["Open", "No date", "Completed", "Open", "Reference", "open", "Open "]));
    else if (r < 0.12) lines.push(pick(["# Title", "### sub", "#nospace", "####### seven", "## "]));
    else if (r < 0.22) lines.push(words(int(0, 8), 0.1));
    else if (r < 0.32) lines.push("");
    else if (r < 0.36) {
      const odd = pick(["- plain bullet", "-[ ] no space", "- [ ]", "- [ ]   ", "- [/] alt box", "+ [ ] plus bullet", " - [ ] one space indent", "- [x]"]);
      if (/^[-*]\s*\[( |x|X)\]\s+.*\S/.test(odd)) allIds = false; // the parser accepts a missing space after the bullet
      lines.push(odd);
    }
    else {
      const withId = chance(0.7);
      if (!withId) allIds = false;
      lines.push(genTaskLine(withId));
      const k = chance(0.4) ? int(1, 4) : 0;
      for (let j = 0; j < k; j++) lines.push(genContinuation());
    }
  }
  const eol = chance(0.8) ? "\n" : "\r\n";
  let text = lines.join(eol);
  if (chance(0.85)) text += eol;
  if (chance(0.1)) text = text.replace(/\n/g, (m, i) => (i % 3 === 0 ? "\n" : m)); // no-op placeholder keeps mixed-EOL rare
  if (chance(0.05)) text = "﻿" + text;
  return { text, allIds };
}

/* ---------------- A: markdown file fuzz ---------------- */
function sectionA(app) {
  console.log("\nA  markdown file fuzz (" + ITERS + " files, seed " + SEED + ")");
  const { MD, Model, SETTINGS } = app;
  const opts = { tagMap: SETTINGS.tagMap };
  const S = { mdStyle: "emoji", writeBlockIds: true };
  let threw = 0, byteDiff = 0, idOnlyDiff = 0, notIdem = 0, countDiff = 0, newProblems = 0, wsTrim = 0, blankLayout = 0;
  const examples = {};
  const ow = console.warn; console.warn = () => {};
  const stripIds = (s) => s.replace(/[ \t]*\^[0-9a-z]{6}(?=\r\n|\n|$)/g, "");
  const stripWs = (s) => s.replace(/[ \t]+(?=\r\n|\n|$)/g, "");
  for (let i = 0; i < ITERS; i++) {
    const { text, allIds } = genFile();
    let p, out;
    try { p = MD.parse(text, opts); out = MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol, bom: p.hadBOM }, S); }
    catch (e) { threw++; examples.threw = examples.threw || { text, err: String(e) }; continue; }
    if (out !== text) {
      if (!text.replace(/﻿/, "").trim()) { blankLayout++; continue; } // a whitespace-only file is laid out like a new one (documented)
      if (allIds) { byteDiff++; examples.byteDiff = examples.byteDiff || { text, out }; }
      else if (stripIds(out) === stripIds(text)) idOnlyDiff++;
      else if (stripWs(stripIds(out)) === stripWs(stripIds(text))) { wsTrim++; examples.wsTrim = examples.wsTrim || { text, out }; }
      else { byteDiff++; examples.byteDiff = examples.byteDiff || { text, out }; }
    }
    let p2, out2;
    try { p2 = MD.parse(out, opts); out2 = MD.serialise(p2.tasks, { blocks: p2.blocks, eol: p2.eol, bom: p2.hadBOM }, S); }
    catch (e) { threw++; examples.threw2 = examples.threw2 || { text: out, err: String(e) }; continue; }
    if (out2 !== out) { notIdem++; examples.notIdem = examples.notIdem || { out, out2 }; }
    if (p2.tasks.length !== p.tasks.length) { countDiff++; examples.countDiff = examples.countDiff || { text, out, n1: p.tasks.length, n2: p2.tasks.length }; }
    else {
      const fp1 = p.tasks.map((t) => Model.fingerprint(t)).sort(), fp2 = p2.tasks.map((t) => Model.fingerprint(t)).sort();
      if (fp1.join("") !== fp2.join("")) { countDiff++; examples.fpDiff = examples.fpDiff || { text, out }; }
    }
    if (p2.problems.length > p.problems.length) { newProblems++; examples.newProblems = examples.newProblems || { text, out, p1: p.problems, p2: p2.problems }; }
  }
  console.warn = ow;
  report("A1 parse/serialise never throw", threw === 0, threw ? threw + " files threw: " + JSON.stringify(examples.threw).slice(0, 300) : ITERS + " files", true);
  report("A2 files whose task lines all carry ^ids round-trip byte-identical", byteDiff === 0, (byteDiff ? byteDiff + " differed, e.g. " + JSON.stringify(examples.byteDiff).slice(0, 400) : "0 differed") + (blankLayout ? " (" + blankLayout + " whitespace-only files were laid out as new files, as documented)" : ""), true);
  report("A3 id-less lines change only by the appended ^id", wsTrim === 0, (idOnlyDiff + " files gained ids only") + (wsTrim ? "; " + wsTrim + " also lost trailing whitespace on the id-less line, e.g. " + JSON.stringify(examples.wsTrim).slice(0, 300) : ""), true);
  report("A4 second parse→serialise cycle is idempotent", notIdem === 0, notIdem ? notIdem + " not idempotent, e.g. " + JSON.stringify(examples.notIdem).slice(0, 400) : "stable", true);
  report("A5 re-parse of the written file yields the same tasks", countDiff === 0, countDiff ? countDiff + " differed, e.g. " + JSON.stringify(examples.countDiff || examples.fpDiff).slice(0, 400) : "same count and fingerprints", true);
  report("A6 the written file introduces no new unreadable lines", newProblems === 0, newProblems ? newProblems + " files, e.g. " + JSON.stringify(examples.newProblems).slice(0, 300) : "", true);
  results.A = { threw, byteDiff, idOnlyDiff, wsTrim, blankLayout, notIdem, countDiff, newProblems, examples };
}

/* ---------------- B: model round-trip ---------------- */
function sectionB(app) {
  console.log("\nB  model → file → model round-trip (" + ITERS * 5 + " tasks × 4 settings)");
  const { MD, Model, SETTINGS } = app;
  const opts = { tagMap: SETTINGS.tagMap };
  const combos = [
    ["emoji ids", { mdStyle: "emoji", writeBlockIds: true }],
    ["bracket ids", { mdStyle: "bracket", writeBlockIds: true }],
    ["emoji no-ids", { mdStyle: "emoji", writeBlockIds: false }],
    ["bracket no-ids", { mdStyle: "bracket", writeBlockIds: false }],
  ];
  /* The entry parser already collapses runs of whitespace, so the plain corpus uses single-space
     words only; tabs/NBSP are covered by probe G15. Three tiers:
       plain        ordinary words, tag labels without '_' or '#'
       tag-hazard   labels containing '_' (ambiguous with the file's space encoding) or '#'
       token-hazard metadata-looking tokens (📅 …, ⏫, [due:: …], #tag, ^id …) inside free text */
  const WORDS_SAFE = WORDS.filter((w) => !/[\t \u00a0\u2028\u2029]/.test(w)); // tabs, NBSP and Unicode line separators are covered by probes G15–G17
  const TAGS_SAFE = ["DPN", "BSM", "Highside", "Two Words", "ünï", "a-b", "x"];
  const TAGS_HAZ = ["snake_case", "C#", "#lead", "trail#", "1st", "a__b"];
  const TOKENS = HAZARDS.filter((h) => !/^[ \t]+$/.test(h));
  const TOKENS_NOTE = TOKENS.filter((h) => !/^[-*] \[/.test(h)); // an indented checkbox line is a sub-task by grammar, never note text
  const text = (n, tier, forNote) => { const out = []; for (let i = 0; i < n; i++) out.push(tier === "token-hazard" && chance(0.25) ? pick(forNote ? TOKENS_NOTE : TOKENS) : pick(WORDS_SAFE)); return out.join(" "); };
  const genTask = (tier) => {
    const done = chance(0.25);
    const tagPool = tier === "tag-hazard" ? TAGS_HAZ : TAGS_SAFE;
    const t = {
      id: freshId(),
      title: text(int(1, 6), tier),
      tags: chance(tier === "tag-hazard" ? 1 : 0.5) ? [pick(tagPool)] : [],
      due: chance(0.6) ? isoRand() : null,
      priority: int(0, 3),
      done,
      doneAt: done ? isoRand() : null,
      note: chance(0.3) ? [text(int(1, 5), tier, true), text(int(1, 5), tier, true)].slice(0, int(1, 2)).join("\n") : null,
      subtasks: chance(0.4) ? [{ text: text(int(1, 4), tier), done: chance(0.5), due: chance(0.4) ? isoRand() : null }] : [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    return Model.validate(t);
  };
  const FIELDS = ["title", "tags", "due", "priority", "done", "doneAt", "note", "subtasks"];
  const summary = {};
  const ow = console.warn; console.warn = () => {};
  for (const [label, S] of combos) {
    const tiers = {};
    for (const tier of ["plain", "tag-hazard", "token-hazard"]) {
      const stat = { n: 0, threw: 0, mismatched: 0, byField: {}, examples: {} };
      const N = tier === "plain" ? ITERS * 3 : ITERS;
      for (let i = 0; i < N; i++) {
        const t = genTask(tier);
        if (!t) continue;
        stat.n++;
        let back, line;
        try {
          line = MD.serialise([t], { blocks: [], eol: "\n" }, S);
          const p = MD.parse(line, opts);
          back = p.tasks[0];
          if (!back) throw new Error("no task parsed back from " + JSON.stringify(line));
        } catch (e) { stat.threw++; stat.examples.threw = stat.examples.threw || { t, err: String(e) }; continue; }
        const bad = FIELDS.filter((f) => JSON.stringify(t[f]) !== JSON.stringify(back[f]));
        if (bad.length) {
          stat.mismatched++;
          for (const f of bad) {
            stat.byField[f] = (stat.byField[f] || 0) + 1;
            if (!stat.examples[f]) stat.examples[f] = { in: t[f], out: back[f], line: line.split("\n").filter((l) => /^\s*[-*] \[/.test(l)) };
          }
        }
      }
      tiers[tier] = stat;
      const fields = Object.entries(stat.byField).sort((a, b) => b[1] - a[1]).map(([f, n]) => f + ":" + n).join(" ");
      const ex = stat.examples.title || stat.examples.due || stat.examples.tags || stat.examples.subtasks || stat.examples.note || stat.examples.priority;
      report("B " + label + " · " + tier, stat.mismatched === 0 && stat.threw === 0,
        (stat.mismatched ? stat.mismatched + " of " + stat.n + " tasks changed (" + fields + ")" : stat.n + " tasks unchanged") +
        (ex ? "; e.g. " + JSON.stringify(ex.line[0]) + " → " + JSON.stringify(ex.out) + " (was " + JSON.stringify(ex.in) + ")" : ""), true);
    }
    summary[label] = tiers;
  }
  console.warn = ow;
  results.B = summary;
}

/* ---------------- C: date language fuzz ---------------- */
function sectionC(app) {
  console.log("\nC  date language fuzz");
  const { DateParse, Util } = app;
  const ALPHA = "0123456789 /-.+dwmb" + "todaytomorrowmonfrieoweom" + "xyz٠۱１２";
  const today = new Date(2026, 7, 25);
  let threw = 0, invalidIso = 0, weirdYear = 0, dates = 0;
  const ex = {};
  for (let i = 0; i < ITERS * 50; i++) {
    let s = ""; const len = int(0, 12);
    for (let j = 0; j < len; j++) s += ALPHA[Math.floor(rnd() * ALPHA.length)];
    if (chance(0.3)) s = pick(["+", "+0", "+999m", "+999b", "+1000", "12 5 0050", "12 5 999", "0 0", "00 00", "31 12 99", "1 1 1", "2026-00-00", "9999-12-31", "0001-01-01", "٣ ٤", "12 5 27 3", "+3 ", " tom ", "TOM", "Fri", "eOw"]);
    let r;
    try { r = DateParse.parse(s, { today, workDays: [false, true, true, true, true, true, false], business: chance(0.5) }); }
    catch (e) { threw++; ex.threw = ex.threw || { s, err: String(e) }; continue; }
    if (r.kind === "date") {
      dates++;
      if (!Util.validISO(r.iso)) { invalidIso++; ex.invalidIso = ex.invalidIso || { s, r }; }
      const typed = /(?:^|\D)(\d{4})(?:\D|$)/.exec(s.trim());
      if (typed && +typed[1] !== +r.iso.slice(0, 4) && !/^\+/.test(s.trim())) { weirdYear++; ex.weirdYear = ex.weirdYear || { s, r }; }
    }
  }
  report("C1 DateParse never throws", threw === 0, threw ? JSON.stringify(ex.threw) : ITERS * 50 + " inputs, " + dates + " resolved to dates", true);
  report("C2 every resolved date is a valid ISO date", invalidIso === 0, invalidIso ? JSON.stringify(ex.invalidIso) : "", true);
  report("C3 a typed four-digit year is the year that comes back", weirdYear === 0, weirdYear ? weirdYear + " inputs resolved to a different year, e.g. " + JSON.stringify(ex.weirdYear) : "", true);
  let plusThrew = 0, plusBad = 0;
  for (const u of ["", "d", "w", "m", "b"]) for (let n = 0; n <= 999; n += 7) { try { const r = DateParse.parse("+" + n + u, { today }); if (r.kind !== "date" || !Util.validISO(r.iso)) plusBad++; } catch (e) { plusThrew++; } }
  report("C4 +N{d,w,m,b} for N ≤ 999 always resolves", plusThrew === 0 && plusBad === 0, "", true);
  results.C = { threw, invalidIso, weirdYear, ex };
}

/* ---------------- D: entry parser fuzz ---------------- */
function sectionD(app) {
  console.log("\nD  entry parser fuzz");
  const { EntryParse, SETTINGS } = app;
  const KEYS = ["d", "b", "t", "D", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype", "zz", "x y", ""];
  let threw = 0, nonString = 0, lostBracket = 0;
  const ex = {};
  for (let i = 0; i < ITERS * 20; i++) {
    const k = pick(KEYS);
    const s = words(int(0, 4), 0.2) + (chance(0.7) ? " [" + k + "] " : "") + words(int(0, 3), 0.2);
    let r;
    try { r = EntryParse.parse(s, SETTINGS.tagMap); } catch (e) { threw++; ex.threw = ex.threw || { s, err: String(e) }; continue; }
    if (!r.tags.every((t) => typeof t === "string")) { nonString++; ex.nonString = ex.nonString || { s, tags: r.tags.map((t) => typeof t) }; }
    const configured = Object.prototype.hasOwnProperty.call(SETTINGS.tagMap, k.toLowerCase());
    if (k && !/\s/.test(k) && !configured && s.includes("[" + k + "]") && !r.title.includes("[" + k + "]")) { lostBracket++; ex.lostBracket = ex.lostBracket || { s, title: r.title }; }
  }
  report("D1 EntryParse never throws", threw === 0, threw ? JSON.stringify(ex.threw) : "", true);
  report("D2 every parsed tag is a string", nonString === 0, nonString ? nonString + " results carried a non-string tag, e.g. " + JSON.stringify(ex.nonString) : "", true);
  report("D3 [word] survives in the title unless word is a configured shortcut", lostBracket === 0, lostBracket ? lostBracket + " titles lost a bracket token, e.g. " + JSON.stringify(ex.lostBracket) : "", true);
  results.D = { threw, nonString, lostBracket, ex };
}

/* ---------------- E: search query fuzz ---------------- */
function sectionE(app) {
  console.log("\nE  search query fuzz");
  const { Filter, Model } = app;
  const ALPHA = "abc #!-:<>0123456789 due:is:has:done undated note overdue today week 日😀";
  const tasks = [];
  for (let i = 0; i < 50; i++) tasks.push(Model.validate({ id: freshId(), title: words(int(1, 5), 0.2), tags: chance(0.5) ? [pick(TAGS)] : [], due: chance(0.5) ? isoRand() : null, priority: int(0, 3), note: chance(0.3) ? words(3) : null }));
  const recs = new Map(tasks.map((t) => [t.id, t.due ? { cal: int(-10, 30), wd: int(-10, 30), overdue: chance(0.3), eff: int(-10, 30) } : null]));
  let threw = 0; let ex = null;
  for (let i = 0; i < ITERS * 20; i++) {
    let q = ""; const len = int(0, 16);
    for (let j = 0; j < len; j++) q += ALPHA[Math.floor(rnd() * ALPHA.length)];
    if (chance(0.2)) q = pick(["due:<", "due:>x", "due:<-3d", "-", "--", "#", "-#", "!!!!", "is:", "has:", "due:<2026-13-40", "\\", "(", "*", "?"]);
    try { const pq = Filter.parseQuery(q); for (const t of tasks) Filter.match(t, pq, { recs }); }
    catch (e) { threw++; ex = ex || { q, err: String(e) }; }
  }
  report("E1 Filter.parseQuery/match never throw", threw === 0, threw ? JSON.stringify(ex) : ITERS * 20 + " queries × 50 tasks", true);
  results.E = { threw, ex };
}

/* ---------------- F: hostile stored records ---------------- */
function sectionF(app) {
  console.log("\nF  hostile stored records (what Model.load would accept from IndexedDB)");
  const { Model, Util } = app;
  // only values structured-clone can put into IndexedDB (no functions or symbols)
  const VALS = [undefined, null, 0, 1, -1, 1.5, NaN, Infinity, "", "x", "garbage", " ", "2026-02-30", "2026-13-01", "2026-01-01", "2026-1-1", "2026-01-01T00:00:00.000Z", true, false, [], [1], ["a"], [null], {}, { text: 1 }, { text: "a" }, { text: "a", done: "yes", due: "garbage" }, new Date(), new Date(NaN), "a".repeat(10000)];
  const FIELDS = ["id", "title", "tags", "due", "priority", "done", "doneAt", "note", "subtasks", "createdAt", "updatedAt", "__proto__", "constructor"];
  let threw = 0, accepted = 0, renderCrash = 0, nanAge = 0;
  const ex = {};
  for (let i = 0; i < ITERS * 10; i++) {
    const rec = { id: idOf(i), title: "t" + i };
    for (const f of FIELDS) if (chance(0.5)) rec[f] = pick(VALS);
    if (chance(0.2)) rec.title = pick(VALS);
    let t;
    try { t = Model.validate(rec); } catch (e) { threw++; ex.threw = ex.threw || { rec: describe(rec), err: String(e) }; continue; }
    if (!t) continue;
    accepted++;
    // what the renderer will call on an accepted record
    try {
      if (t.due) Util.fmtShort(t.due, new Date());
      if (t.done) { Util.fmtLong(t.doneAt); Util.fmtShort(t.doneAt, new Date()); }
      for (const s of t.subtasks) if (s.due) Util.fmtShort(s.due, new Date());
    } catch (e) { renderCrash++; ex.renderCrash = ex.renderCrash || { rec: describe(rec), accepted: { done: t.done, doneAt: describe({ v: t.doneAt }).v }, err: String(e) }; }
    const age = Util.daysBetween(Util.midnight(new Date(t.createdAt)), new Date());
    if (!Number.isFinite(age)) { nanAge++; ex.nanAge = ex.nanAge || { createdAt: describe({ v: t.createdAt }).v, updatedAt: describe({ v: t.updatedAt }).v }; }
  }
  report("F1 Model.validate never throws on hostile records", threw === 0, threw ? JSON.stringify(ex.threw).slice(0, 300) : ITERS * 10 + " records, " + accepted + " accepted", true);
  report("F2 records validate() accepts cannot crash the renderer's date helpers", renderCrash === 0, renderCrash ? renderCrash + " accepted records throw when rendered, e.g. " + JSON.stringify(ex.renderCrash).slice(0, 400) : "", true);
  report("F3 records validate() accepts have finite ages (createdAt/updatedAt)", nanAge === 0, nanAge ? nanAge + " accepted records give NaN ages in stats, e.g. " + JSON.stringify(ex.nanAge) : "", true);
  results.F = { threw, accepted, renderCrash, nanAge, ex };
  function describe(o) { const r = {}; for (const k of Object.keys(o)) { const v = o[k]; r[k] = v instanceof Date ? "<Date " + (isNaN(v) ? "invalid" : v.toISOString()) + ">" : typeof v === "string" && v.length > 20 ? v.slice(0, 20) + "…" : typeof v === "number" && !Number.isFinite(v) ? String(v) : v; } return r; }
}

/* ---------------- G: named probes ---------------- */
function sectionG(app) {
  console.log("\nG  named probes");
  const { MD, Model, Util, EntryParse, DateParse, SETTINGS } = app;
  const TM = SETTINGS.tagMap;
  const opts = { tagMap: TM };
  { const e = EntryParse.parse("Fix [constructor] handling", TM);
    report("G1 [constructor] in a title is not treated as a tag shortcut", e.title === "Fix [constructor] handling" && e.tags.length === 0, "got title " + JSON.stringify(e.title) + ", tags " + JSON.stringify(e.tags.map((x) => typeof x)), true); }
  { const p = MD.parse("## Open\n- [ ] Check [__proto__] usage ^aaaaaa\n", opts);
    report("G2 [__proto__] in a file line stays in the title", p.tasks[0].title === "Check [__proto__] usage", "got " + JSON.stringify(p.tasks[0].title), true); }
  { const t = Model.validate({ id: "abcdef", title: "x", done: true, doneAt: "garbage" });
    let threw = null; try { Util.fmtLong(t.doneAt); } catch (e) { threw = e.constructor.name; }
    report("G3 validate() rejects or repairs an unreadable doneAt", !t || Util.validISO(t.doneAt), "validate kept doneAt=" + JSON.stringify(t && t.doneAt) + (threw ? "; fmtLong throws " + threw + " (the completed list and stats render this)" : ""), true); }
  { const t = Model.validate({ id: "zz0001", title: "Watch 📅 2026-01-01 movie", due: "2026-09-10" });
    const p = MD.parse(MD.serialise([t], { blocks: [], eol: "\n" }, SETTINGS), opts);
    report("G4 a title containing a date token keeps its real due date across a save", p.tasks[0].due === "2026-09-10" && p.tasks[0].title === t.title, "due " + t.due + " → " + p.tasks[0].due + ", title → " + JSON.stringify(p.tasks[0].title), true); }
  { const t = Model.validate({ id: "zz0002", title: "Rotate ⏫ certs" });
    const p = MD.parse(MD.serialise([t], { blocks: [], eol: "\n" }, SETTINGS), opts);
    report("G5 a title containing a priority emoji round-trips exactly as the model holds it", p.tasks[0].priority === t.priority && p.tasks[0].title === t.title, "model priority " + t.priority + " → " + p.tasks[0].priority + ", title " + JSON.stringify(t.title) + " → " + JSON.stringify(p.tasks[0].title), true); }
  { const t = Model.validate({ id: "zz0003", title: "P", subtasks: [{ text: "call 📅 2026-01-01 bob", done: false, due: null }] });
    const p = MD.parse(MD.serialise([t], { blocks: [], eol: "\n" }, SETTINGS), opts);
    report("G6 a sub-task whose text contains a date token round-trips", JSON.stringify(p.tasks[0].subtasks[0]) === JSON.stringify(t.subtasks[0]), "→ " + JSON.stringify(p.tasks[0].subtasks[0]), true); }
  { const S2 = Object.assign({}, SETTINGS, { writeBlockIds: false });
    const t = Model.validate({ id: "zz0004", title: "See block ^k9k9k9" });
    const line = MD.serialise([t], { blocks: [], eol: "\n" }, S2);
    const p = MD.parse(line, opts);
    report("G7 writeBlockIds=off: an undated title ending in ^token keeps its title", p.tasks[0].title === t.title, JSON.stringify(line.trim().split("\n").pop()) + " → title " + JSON.stringify(p.tasks[0].title) + ", id " + p.tasks[0].id, true); }
  { /* the app's own decoder (Util.decodeUtf8, v1.3.0) or, on older builds, the lenient decoder it used */
    const decode = (buf) => { if (!Util.decodeUtf8) return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf) }; try { return { text: Util.decodeUtf8(buf) }; } catch (e) { return { refused: e.name + ": " + (e.reason || e.message) }; } };
    const latin1 = Buffer.from("## Open\n- [ ] Caf\xe9 ^aaaaaa\nPr\xe9face\n", "latin1");
    const d1 = decode(latin1);
    let ok8 = !!d1.refused, detail8 = d1.refused ? "refused: " + d1.refused : "";
    if (!d1.refused) { const p = MD.parse(d1.text, opts); const out = Buffer.from(MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, SETTINGS), "utf8"); ok8 = out.equals(latin1); detail8 = "decoder yields " + JSON.stringify(d1.text.split("\n")[1]) + "; a save writes " + out.length + " bytes vs " + latin1.length + " original"; }
    report("G8 a Latin-1 file is refused, never rewritten with U+FFFD replacement characters", ok8, detail8, true);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("## Open\n- [ ] Hello ^aaaaaa\n", "utf16le")]);
    const d16 = decode(utf16);
    const n16 = d16.refused ? null : MD.parse(d16.text, opts).tasks.length;
    report("G9 a UTF-16 file is recognised (or refused) rather than read as an empty task list", !!d16.refused || n16 === 1, d16.refused ? "refused: " + d16.refused : "decoded as UTF-8 it yields " + n16 + " tasks of NUL-laced text that a first connect would write back", true); }
  { const RealDate = Date;
    const at = (iso) => { const fixed = new RealDate(iso + "T12:00:00"); global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } static now() { return fixed.getTime(); } }; };
    const src = "## Completed\n- [x] done but undated ^d0d0d0\n";
    at("2026-09-01"); const app1 = loadApp(); const model = app1.MD.parse(src, opts).tasks;
    at("2026-09-02"); const p2 = app1.MD.parse(src, opts);
    global.Date = RealDate;
    const out = app1.MD.serialise(model, { blocks: p2.blocks, eol: p2.eol }, app1.SETTINGS);
    report("G10 an unchanged completed line without a ✅ date stays byte-identical across days", out === src, "next save writes " + JSON.stringify(out.split("\n")[1]), true); }
  { const p = MD.parse("## Open\n- [ ] trailing spaces   \n", opts);
    const out = MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, SETTINGS);
    report("G11 an id-less line keeps its trailing whitespace when the id is appended", /^- \[ \] trailing spaces    \^[0-9a-z]{6}$/.test(out.split("\n")[1]), "wrote " + JSON.stringify(out.split("\n")[1]) + " (README: the only thing added to a hand-written line is its ^id)", true); }
  { const p = MD.parse("## Open\n- [ ] tab\tand nbsp here ^t4bt4b\n", opts);
    report("G15 tabs/NBSP inside a title are preserved in the model", p.tasks[0].title === "tab\tand nbsp here", "parsed title " + JSON.stringify(p.tasks[0].title) + " — whitespace runs are collapsed to one space (the entry field does the same, so only hand-written or imported text is affected)", false); }
  { const r = DateParse.parse("12 5 0050", { today: new Date(2026, 7, 25) });
    report("G12 a four-digit year below 100 is refused or kept literally", r.kind === "invalid" || r.iso === "0050-05-12", "resolved to " + JSON.stringify(r.iso || r.reason), true);
    report("G13 parseISO/isoOf round-trip for a year below 100", Util.isoOf(Util.parseISO("0050-06-01")) === "0050-06-01", "0050-06-01 → " + Util.isoOf(Util.parseISO("0050-06-01")), true); }
  { const t = Model.validate({ id: "ls0001", title: "line separator", due: "2030-01-01" });
    const p = MD.parse(MD.serialise([t], { blocks: [], eol: "\n" }, SETTINGS), opts);
    report("G16 a U+2028 line separator inside a title does not make the task vanish", p.tasks.length === 1, "parsed back " + p.tasks.length + " task(s), " + p.problems.length + " problem(s) reported — the line is kept as raw text, so the task disappears from the app without a warning", true);
    const t2 = Model.validate({ id: "ls0002", title: "clean", subtasks: [{ text: "sub text", done: false, due: null }] });
    const p2 = MD.parse(MD.serialise([t2], { blocks: [], eol: "\n" }, SETTINGS), opts);
    report("G17 a U+2028 inside a sub-task keeps the sub-task attached to its task", p2.tasks[0].subtasks.length === 1, "sub-tasks back: " + p2.tasks[0].subtasks.length, true); }
  { const p = MD.parse("## Open\n- [ ] Parent ^p1p1p1\n    first note line\n    \n    second note line after a whitespace-only line\n    - [ ] sub after blank\n", opts);
    report("G14 a whitespace-only line inside a note ends the task's continuation (documented limit)", p.tasks[0].note === "first note line" && p.tasks[0].subtasks.length === 0, "note=" + JSON.stringify(p.tasks[0].note) + ", subtasks=" + p.tasks[0].subtasks.length + " — the rest is preserved as raw lines", false); }
}

/* ---------------- main ---------------- */
const app = loadApp();
console.log("robust-fuzz · seed " + SEED + " · iters " + ITERS + " · node " + process.version);
sectionA(app);
sectionB(app);
sectionC(app);
sectionD(app);
sectionE(app);
sectionF(app);
sectionG(app);
const ok = results.checks.filter((c) => c.ok).length;
console.log("\n" + ok + " / " + results.checks.length + " properties held · " + findings + " finding(s)");
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log("results written to " + OUT); }
process.exitCode = 0;
