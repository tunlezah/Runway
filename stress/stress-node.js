#!/usr/bin/env node
/* stress-node.js — stress test for Runway's markdown engine (MD.parse / MD.serialise).

   Loads the real modules out of runway.html (same extraction as test.js), generates
   synthetic todo.md files at increasing scale, and measures the exact CPU cost of the
   operations the app performs on every load, save, and window-focus:

     parse       MD.parse(text)                      — every load / reconcile / after-write
     serialise   MD.serialise(tasks, blocks)         — every autosave flush
     hash        Util.hash(text)                     — flush (×2) and every window focus
     saveCycle   serialise + 2×hash + parse          — the full CPU cost of one autosave
     fsWrite     fs.writeFileSync                    — stand-in for the FSA write

   Also runs a robustness corpus (malformed dates, duplicate/missing ^ids at scale,
   fuzz lines, giant lines, giant notes, CRLF/BOM handling, adversarial titles) and a
   crash-threshold finder for the serialiser's spread-argument stack overflow.

   Symbols: ✓ behaved safely · ⚠ FINDING (defect demonstrated) · ✗ unexpected failure

   Usage:  node --expose-gc stress/stress-node.js [--quick] [--out results.json]
*/
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { performance } = require("perf_hooks");

const QUICK = process.argv.includes("--quick");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const SRC = fs.readFileSync(path.join(__dirname, "..", "runway.html"), "utf8");
const M = /\/\*JS-START\*\/([\s\S]*?)\/\*JS-END\*\//.exec(SRC);
if (!M) { console.error("no JS markers"); process.exit(2); }
const JS = M[1];

/* Fresh module instance (isolated Model/SETTINGS) per call. */
function loadApp() {
  const mod = { exports: {} };
  new Function("module", "exports", JS)(mod, mod.exports);
  return mod.exports;
}

/* ---------------- deterministic generator ---------------- */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ("patch review deploy rotate audit backup restore triage escalate verify sign scan build test merge document renew invoice schedule brief firewall sensor endpoint kernel registry cluster tunnel beacon parser sandbox quarantine payload telemetry console dashboard token cert vault agent runbook enclave badge printer laptop switch rack camera door lease licence").split(" ");
const TAGS = ["DPN", "BSM", "Highside", "ops", "home"];
const REF = new Date(2026, 8, 2); // 2026-09-02: date spread anchor

function isoOffset(days) {
  const d = new Date(REF.getFullYear(), REF.getMonth(), REF.getDate() + days);
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function idOf(i) { return i.toString(36).padStart(6, "0"); }

/* Build N task objects shaped exactly like Model records. */
function genTasks(N, opts) {
  opts = opts || {};
  const rnd = mulberry32(opts.seed || 42);
  const doneShare = opts.doneShare === undefined ? 0.3 : opts.doneShare;
  const subMin = opts.subMin || 0, subMax = opts.subMax === undefined ? 3 : opts.subMax;
  const subShare = opts.subShare === undefined ? 0.25 : opts.subShare;
  const noteShare = opts.noteShare === undefined ? 0.15 : opts.noteShare;
  const tasks = [];
  for (let i = 0; i < N; i++) {
    const nw = 3 + Math.floor(rnd() * 5);
    let title = [];
    for (let w = 0; w < nw; w++) title.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    title = title.join(" ") + (rnd() < 0.3 ? " " + Math.floor(rnd() * 900 + 100) : "");
    const done = rnd() < doneShare;
    const dated = done || rnd() < 0.65;
    const due = dated ? isoOffset(Math.floor(rnd() * 150) - 60) : null;
    const tags = [];
    if (rnd() < 0.5) tags.push(TAGS[Math.floor(rnd() * TAGS.length)]);
    if (rnd() < 0.1) tags.push(TAGS[Math.floor(rnd() * TAGS.length)]);
    const subtasks = [];
    if (rnd() < subShare) {
      const ns = subMin + Math.floor(rnd() * (subMax - subMin + 1));
      for (let s = 0; s < ns; s++)
        subtasks.push({ text: "step " + (s + 1) + " " + WORDS[Math.floor(rnd() * WORDS.length)], done: rnd() < 0.4, due: rnd() < 0.2 ? isoOffset(Math.floor(rnd() * 30)) : null });
    }
    const note = rnd() < noteShare ? "Context line one for item " + i + (rnd() < 0.4 ? "\nSecond context line." : "") : null;
    tasks.push({
      id: idOf(i), title, tags: [...new Set(tags)], due,
      priority: rnd() < 0.15 ? 1 + Math.floor(rnd() * 3) : 0,
      done, doneAt: done ? (due || isoOffset(-Math.floor(rnd() * 30))) : null,
      note, subtasks,
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    });
  }
  return tasks;
}

/* Assemble an app-written file from MD.renderTask per task. Byte-identical to
   MD.serialise-with-empty-blocks output (asserted below), but scales past the
   serialiser's spread-argument crash so we can generate 100k+ files. */
function assembleFile(app, tasks, settings) {
  settings = settings || app.SETTINGS;
  const bySect = { Open: [], "No date": [], Completed: [] };
  for (const t of tasks) bySect[app.MD.targetSection(t)].push(t);
  const lines = ["# To Do", "\x3c!-- Runway v1 · edit freely; the app preserves anything it does not recognise --\x3e"];
  for (const sect of ["Open", "No date", "Completed"]) {
    if (!bySect[sect].length) continue;
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push("## " + sect);
    for (const t of bySect[sect]) for (const l of app.MD.renderTask(t, settings)) lines.push(l);
  }
  return lines.join("\n") + "\n";
}

function genFile(N, opts) {
  const app = loadApp();
  const tasks = genTasks(N, opts).map(t => app.Model.validate(t)).filter(Boolean);
  const settings = Object.assign({}, app.SETTINGS, opts && opts.settings);
  return { text: assembleFile(app, tasks, settings), count: tasks.length };
}

/* ---------------- measurement helpers ---------------- */
function gc() { if (global.gc) { global.gc(); global.gc(); } }
function timeIt(fn, runs) {
  const raw = [];
  let ret;
  for (let r = 0; r < runs; r++) { const t0 = performance.now(); ret = fn(); raw.push(performance.now() - t0); }
  const out = [...raw].sort((a, b) => a - b);
  // cold = first run on a fresh module (≈ what a page load pays, JIT included)
  return { cold: raw[0], median: out[Math.floor(out.length / 2)], min: out[0], max: out[out.length - 1], ret };
}
const ms = v => v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
const mb = b => Math.round(b / 1024 / 102.4) / 10;

/* ---------------- self-check: assembleFile ≡ MD.serialise(blocks:[]) ---------------- */
function generatorSelfCheck() {
  const app = loadApp();
  const tasks = genTasks(10000).map(t => app.Model.validate(t)).filter(Boolean);
  const viaSerialise = app.MD.serialise(tasks, { blocks: [], eol: "\n" }, app.SETTINGS);
  const viaAssemble = assembleFile(app, tasks);
  if (viaSerialise !== viaAssemble) {
    let i = 0; while (viaSerialise[i] === viaAssemble[i]) i++;
    throw new Error("generator drift vs app serialiser at byte " + i + ": " + JSON.stringify(viaSerialise.slice(i - 40, i + 40)) + " vs " + JSON.stringify(viaAssemble.slice(i - 40, i + 40)));
  }
  console.log("generator self-check: assembleFile is byte-identical to MD.serialise at 10k tasks");
}

/* ---------------- scale sweep ---------------- */
function scaleSweep(results) {
  const SCALES = QUICK ? [100, 1000, 10000, 50000] : [100, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
  console.log("\n=== SCALE SWEEP (realistic files: 30% completed, 25% of tasks have 0-3 subtasks, 15% notes) ===");
  console.log("tasks      bytes     lines    parse(ms)  serialise  hash   saveCycle  fsWrite  heapΔ(MB)  roundtrip");
  for (const N of SCALES) {
    const runs = N <= 20000 ? 5 : N <= 100000 ? 3 : 2;
    const { text, count } = genFile(N);
    if (count !== N) throw new Error("generator produced " + count + "/" + N);
    const app = loadApp();
    const TM = app.SETTINGS.tagMap;
    const lineCount = text.split("\n").length;

    gc();
    const h0 = process.memoryUsage().heapUsed;
    const tParse = timeIt(() => app.MD.parse(text, { tagMap: TM }), runs);
    const parsed = tParse.ret;
    gc();
    const h1 = process.memoryUsage().heapUsed;

    if (parsed.tasks.length !== N) throw new Error("parse lost tasks: " + parsed.tasks.length + "/" + N);
    if (parsed.problems.length) throw new Error("unexpected problems: " + parsed.problems.length);

    const st = { blocks: parsed.blocks, eol: parsed.eol };
    const tSer = timeIt(() => app.MD.serialise(parsed.tasks, st, app.SETTINGS), runs);
    const rt = tSer.ret;
    const identical = rt === text;

    // dirty-serialise: touch one task so its block re-renders (the realistic save path)
    const app2 = loadApp();
    const p2 = app2.MD.parse(text, { tagMap: TM });
    p2.tasks[Math.floor(N / 2)].title += " edited";
    const rt2 = app2.MD.serialise(p2.tasks, { blocks: p2.blocks, eol: p2.eol }, app2.SETTINGS);
    const reparsed = app2.MD.parse(rt2, { tagMap: TM });
    const editSurvives = reparsed.tasks.length === N && reparsed.tasks[Math.floor(N / 2)].title.endsWith(" edited");

    const tHash = timeIt(() => app.Util.hash(text), runs);
    const tCycle = timeIt(() => {
      const t2 = app.MD.serialise(parsed.tasks, st, app.SETTINGS);
      app.Util.hash(t2); app.Util.hash(t2);
      return app.MD.parse(t2, { tagMap: TM });
    }, runs);
    const tmp = path.join(os.tmpdir(), "runway-stress-" + N + ".md");
    const tWrite = timeIt(() => fs.writeFileSync(tmp, text), runs);
    fs.unlinkSync(tmp);

    const row = {
      tasks: N, bytes: text.length, lines: lineCount,
      parseMs: tParse.median, parseColdMs: tParse.cold, serialiseMs: tSer.median, hashMs: tHash.median,
      saveCycleMs: tCycle.median, saveCycleColdMs: tCycle.cold, fsWriteMs: tWrite.median,
      heapMB: (h1 - h0) / 1048576, roundtripIdentical: identical, editSurvives,
    };
    results.scale.push(row);
    console.log(
      String(N).padEnd(10) + String(text.length).padEnd(10) + String(lineCount).padEnd(9) +
      String(ms(tParse.median)).padEnd(11) + String(ms(tSer.median)).padEnd(11) + String(ms(tHash.median)).padEnd(7) +
      String(ms(tCycle.median)).padEnd(11) + String(ms(tWrite.median)).padEnd(9) +
      String(mb(h1 - h0)).padEnd(11) + (identical ? "byte-identical" : "MISMATCH") + (editSurvives ? "" : "  EDIT-LOST")
    );
  }
}

/* ---------------- subtask sweep ---------------- */
function subtaskSweep(results) {
  console.log("\n=== SUBTASK SWEEP A: one task, M subtasks ===");
  console.log("subs       bytes     parse(ms)  serialise  fingerprint  snap(ms)  roundtrip");
  const MS = QUICK ? [100, 1000, 10000] : [10, 100, 1000, 5000, 10000, 50000];
  for (const Msubs of MS) {
    const app = loadApp();
    const subs = [];
    for (let i = 0; i < Msubs; i++) subs.push({ text: "sub step " + i, done: i % 3 === 0, due: i % 5 === 0 ? "2026-09-20" : null });
    const t = app.Model.validate({ id: "aaaaaa", title: "mega task", tags: [], due: "2026-09-10", priority: 0, done: false, doneAt: null, note: null, subtasks: subs, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" });
    const text = assembleFile(app, [t]);
    const runs = Msubs <= 10000 ? 5 : 3;
    const tParse = timeIt(() => app.MD.parse(text, { tagMap: app.SETTINGS.tagMap }), runs);
    const parsed = tParse.ret;
    const okCount = parsed.tasks.length === 1 && parsed.tasks[0].subtasks.length === Msubs;
    let identical = null, serMedian = null, crashed = null;
    try {
      const tSer = timeIt(() => app.MD.serialise(parsed.tasks, { blocks: parsed.blocks, eol: parsed.eol }, app.SETTINGS), runs);
      identical = tSer.ret === text; serMedian = tSer.median;
    } catch (e) { crashed = e.constructor.name + ": " + e.message; }
    const tFp = timeIt(() => app.Model.fingerprint(parsed.tasks[0]), runs);
    const tSnap = timeIt(() => app.Util.snap(parsed.tasks[0].subtasks), runs);
    results.subtasksSingle.push({ subs: Msubs, bytes: text.length, parseMs: tParse.median, serialiseMs: serMedian, fingerprintMs: tFp.median, snapMs: tSnap.median, ok: okCount, roundtripIdentical: identical, serialiseCrash: crashed });
    console.log(String(Msubs).padEnd(11) + String(text.length).padEnd(10) + String(ms(tParse.median)).padEnd(11) + String(serMedian === null ? "CRASH" : ms(serMedian)).padEnd(11) + String(ms(tFp.median)).padEnd(13) + String(ms(tSnap.median)).padEnd(10) + (crashed ? "SERIALISE CRASH: " + crashed : okCount ? (identical ? "byte-identical" : "MISMATCH") : "COUNT WRONG"));
  }

  console.log("\n=== SUBTASK SWEEP B: 5000 tasks × M subtasks each ===");
  console.log("subs/task  totalsubs  bytes     parse(ms)  serialise  saveCycle  roundtrip");
  for (const per of QUICK ? [5, 20] : [5, 20, 50]) {
    const app = loadApp();
    const { text } = genFile(5000, { subShare: 1, subMin: per, subMax: per });
    const runs = 3;
    const tParse = timeIt(() => app.MD.parse(text, { tagMap: app.SETTINGS.tagMap }), runs);
    const parsed = tParse.ret;
    const totalSubs = parsed.tasks.reduce((s, t) => s + t.subtasks.length, 0);
    const st = { blocks: parsed.blocks, eol: parsed.eol };
    const tSer = timeIt(() => app.MD.serialise(parsed.tasks, st, app.SETTINGS), runs);
    const tCycle = timeIt(() => { const t2 = app.MD.serialise(parsed.tasks, st, app.SETTINGS); app.Util.hash(t2); app.Util.hash(t2); return app.MD.parse(t2, { tagMap: app.SETTINGS.tagMap }); }, runs);
    const identical = tSer.ret === text;
    results.subtasksMany.push({ perTask: per, totalSubs, bytes: text.length, parseMs: tParse.median, serialiseMs: tSer.median, saveCycleMs: tCycle.median, roundtripIdentical: identical });
    console.log(String(per).padEnd(11) + String(totalSubs).padEnd(11) + String(text.length).padEnd(10) + String(ms(tParse.median)).padEnd(11) + String(ms(tSer.median)).padEnd(11) + String(ms(tCycle.median)).padEnd(11) + (identical ? "byte-identical" : "MISMATCH"));
  }
}

/* ---------------- robustness corpus ---------------- */
function robustness(results) {
  console.log("\n=== ROBUSTNESS CORPUS ===");
  const add = (name, ok, detail, finding) => {
    results.robustness.push({ name, ok, finding: !!finding, detail });
    console.log((ok ? "✓ " : finding ? "⚠ FINDING " : "✗ ") + name + (detail ? " — " + detail : ""));
  };

  { // R1: 10k invalid dates → all reported as problems, all lines preserved, tasks kept undated
    const app = loadApp();
    const lines = ["## Open"];
    for (let i = 0; i < 10000; i++) lines.push("- [ ] bad date item " + i + " 📅 2026-02-31 ^" + idOf(i));
    const text = lines.join("\n") + "\n";
    const t0 = performance.now();
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    const dt = performance.now() - t0;
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    add("R1 10k invalid dates: reported + preserved", p.problems.length === 10000 && p.tasks.length === 10000 && p.tasks.every(t => t.due === null) && rt === text, "parse " + ms(dt) + "ms, problems=" + p.problems.length);
  }

  { // R2: 10k tasks all claiming the same ^id → fresh ids, nothing lost, console.warn per dup
    const app = loadApp();
    let warns = 0; const ow = console.warn; console.warn = () => { warns++; };
    const lines = ["## Open"];
    for (let i = 0; i < 10000; i++) lines.push("- [ ] dup id item " + i + " 📅 2026-09-10 ^aaaaaa");
    const text = lines.join("\n") + "\n";
    const t0 = performance.now();
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    const dt = performance.now() - t0;
    console.warn = ow;
    const uniq = new Set(p.tasks.map(t => t.id)).size;
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    const p2 = app.MD.parse(rt, { tagMap: app.SETTINGS.tagMap });
    const titles = new Set(p2.tasks.map(t => t.title));
    add("R2 10k duplicate ^ids: deduped, no loss", uniq === 10000 && titles.size === 10000, "parse " + ms(dt) + "ms, console.warn ×" + warns);
  }

  { // R3a: deterministic demo — two DATED id-less tasks whose generated ids collide
    //       (Math.random stubbed to force the collision the statistics in R3b make rare)
    const app = loadApp();
    const or = Math.random; Math.random = () => 0.5; // newId → "i00000" every time
    const text = "## Open\n- [ ] first casualty 📅 2026-09-10\n- [ ] second survivor 📅 2026-09-11\n";
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    Math.random = or;
    const ids = p.tasks.map(t => t.id);
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    const p2 = app.MD.parse(rt, { tagMap: app.SETTINGS.tagMap });
    const titles = p2.tasks.map(t => t.title);
    const lost = !titles.includes("first casualty");
    const duped = titles.filter(t => t === "second survivor").length;
    add("R3a generated-id collision on dated id-less tasks silently loses content", !lost, "ids=" + JSON.stringify(ids) + " → after save titles=" + JSON.stringify(titles) + " (one task overwritten by the other)", lost);
  }

  { // R3b: id-less files at scale — how often does R3a's collision actually happen?
    console.log("  R3b id-less import (no ^ids, dated): generated-id collision frequency (space 36^6 ≈ 2.18e9)");
    const ow = console.warn; console.warn = () => {};
    for (const [K, trials] of QUICK ? [[10000, 5], [100000, 2]] : [[1000, 30], [10000, 30], [50000, 10], [100000, 5]]) {
      let collidedTrials = 0, totalDups = 0, lossDemonstrated = 0, titlesLost = 0;
      for (let tr = 0; tr < trials; tr++) {
        const app = loadApp(); // fresh Model — byId empty, worst case (fresh browser load)
        const lines = ["## Open"];
        for (let i = 0; i < K; i++) lines.push("- [ ] idless item " + i + " 📅 " + isoOffset(i % 60));
        const p = app.MD.parse(lines.join("\n") + "\n", { tagMap: app.SETTINGS.tagMap });
        const uniq = new Set(p.tasks.map(t => t.id)).size;
        if (uniq < K) {
          collidedTrials++; totalDups += K - uniq;
          const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
          const p2 = app.MD.parse(rt, { tagMap: app.SETTINGS.tagMap });
          const distinctTitles = new Set(p2.tasks.map(t => t.title)).size;
          if (distinctTitles < K) { lossDemonstrated++; titlesLost += K - distinctTitles; }
        }
      }
      const expected = (K * (K - 1)) / 2 / Math.pow(36, 6);
      const line = collidedTrials + "/" + trials + " trials collided (expected ≈" + expected.toFixed(3) + "/trial), dup ids " + totalDups + ", content loss in " + lossDemonstrated + " trial(s), " + titlesLost + " task(s) lost";
      results.robustness.push({ name: "R3b idless K=" + K, ok: lossDemonstrated === 0, finding: lossDemonstrated > 0, detail: line });
      console.log("    K=" + String(K).padEnd(7) + line);
    }
    console.warn = ow;
  }

  { // R4: one 5MB title line
    const app = loadApp();
    const big = "x".repeat(5 * 1024 * 1024);
    const text = "## Open\n- [ ] " + big + " ^aaaaaa\n";
    const t = timeIt(() => app.MD.parse(text, { tagMap: app.SETTINGS.tagMap }), 3);
    const p = t.ret;
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    add("R4 5MB single-line title", p.tasks.length === 1 && p.tasks[0].title.length === big.length && rt === text, "parse " + ms(t.median) + "ms");
  }

  { // R5: one task with 200k note lines — parse is fine; serialise crashes (spread args)
    const app = loadApp();
    const lines = ["## Open", "- [ ] host of a giant note ^aaaaaa"];
    for (let i = 0; i < 200000; i++) lines.push("    note line " + i + " with some detail");
    const text = lines.join("\n") + "\n";
    const t = timeIt(() => app.MD.parse(text, { tagMap: app.SETTINGS.tagMap }), 3);
    const p = t.ret;
    let crash = null, rtOk = false;
    try { rtOk = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS) === text; } catch (e) { crash = e.constructor.name; }
    add("R5 200k-line note: parse ok (" + ms(t.median) + "ms) but SERIALISE " + (crash ? "CRASHES (" + crash + ") — autosave of this file can never succeed" : "ok"), !crash && p.tasks.length === 1 && rtOk, mb(text.length) + "MB file", !!crash);
  }

  { // R6: deep-nested checkbox lists flatten to one level of subtasks (documented behaviour)
    const app = loadApp();
    const text = "## Open\n- [ ] parent ^aaaaaa\n    - [ ] child\n        - [ ] grandchild\n            - [x] great-grandchild\n";
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    add("R6 nested lists flatten to one level (preserved raw until edited)", p.tasks[0].subtasks.length === 3 && rt === text, "3 nested levels → " + p.tasks[0].subtasks.length + " flat subtasks");
  }

  { // R7: 50k fuzz lines interleaved with 5k valid tasks — nothing destroyed
    const app = loadApp();
    const rnd = mulberry32(7);
    const junkChars = "λ🙃𝔘 \t¬~`[]()<>*#-!x ✅📅⏫";
    const lines = ["# junk header", "## Open"];
    let vi = 0;
    for (let i = 0; i < 55000; i++) {
      if (i % 11 === 0 && vi < 5000) { lines.push("- [ ] real task " + vi + " ^" + idOf(vi)); vi++; continue; }
      let s = "";
      const len = Math.floor(rnd() * 60);
      for (let c = 0; c < len; c++) s += junkChars[Math.floor(rnd() * junkChars.length)];
      lines.push(s);
    }
    const text = lines.join("\n") + "\n";
    const t0 = performance.now();
    let p, threw = null;
    try { p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap }); } catch (e) { threw = e; }
    const dt = performance.now() - t0;
    let pass = false, detail = "THREW: " + threw;
    if (!threw) {
      const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
      const real = p.tasks.filter(t => /^real task \d+$/.test(t.title)).length;
      pass = real === 5000 && rt === text;
      detail = "parse " + ms(dt) + "ms, recovered " + real + "/5000 real tasks among " + p.tasks.length + " parsed, fuzz preserved byte-identical: " + (rt === text);
    }
    add("R7 50k fuzz lines + 5k real tasks", pass, detail);
  }

  { // R8: mixed CRLF/LF → majority EOL wins, whole file normalised on save (content intact)
    const app = loadApp();
    const parts = [];
    for (let i = 0; i < 100; i++) parts.push("- [ ] mixed eol " + i + " ^" + idOf(i) + (i % 3 === 0 ? "\n" : "\r\n"));
    const text = "## Open\r\n" + parts.join("");
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    const norm = rt.split("\r\n").length - 1;
    add("R8 mixed EOL: normalised to majority, no content change", p.eol === "\r\n" && p.tasks.length === 100 && norm >= 100 && rt.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n"), "minority-LF lines rewritten as CRLF on save");
  }

  { // R9: BOM stripped on parse and NOT restored on save
    const app = loadApp();
    const text = "﻿## Open\n- [ ] bom task ^aaaaaa\n";
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    const dropped = p.hadBOM === true && !rt.startsWith("﻿");
    add("R9 BOM detected but dropped on save (cosmetic)", !dropped, "a UTF-8 BOM file is rewritten without its BOM", dropped);
  }

  { // R10: adversarial titles containing " ^token " — the id extractor eats mid-title carets
    const app = loadApp();
    const text = "## Open\n- [ ] Review PR ^123 for the parser ^aaaaaa\n- [ ] Fix the ^caret bug ^aaaaab\n";
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    const t0 = p.tasks[0], t1 = p.tasks[1];
    const mangled = t0.title !== "Review PR ^123 for the parser" || t1.title !== "Fix the ^caret bug";
    add("R10 mid-title ^tokens eaten by id extraction", !mangled, JSON.stringify({ got0: t0.title, id0: t0.id, got1: t1.title, id1: t1.id }), mangled);
  }

  { // R11: 1M raw prose lines (huge non-task markdown around a few tasks)
    const app = loadApp();
    const lines = ["# Notes"];
    for (let i = 0; i < 1000000; i++) lines.push("prose line " + i + " that the app must never touch");
    lines.push("## Open", "- [ ] needle in a haystack ^aaaaaa");
    const text = lines.join("\n") + "\n";
    gc(); const h0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    const dt = performance.now() - t0;
    gc(); const h1 = process.memoryUsage().heapUsed;
    const rt = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    add("R11 1M raw prose lines + 1 task", p.tasks.length === 1 && rt === text, "parse " + ms(dt) + "ms, " + mb(text.length) + "MB file, retained heap +" + mb(h1 - h0) + "MB");
  }

  { // R12: serialise → parse → serialise is idempotent after edits at 20k
    const app = loadApp();
    const { text } = genFile(20000);
    const p = app.MD.parse(text, { tagMap: app.SETTINGS.tagMap });
    for (let i = 0; i < p.tasks.length; i += 97) { const t = p.tasks[i]; if (!t.done) { t.done = true; t.doneAt = "2026-09-02"; } }
    const rt1 = app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS);
    const p2 = app.MD.parse(rt1, { tagMap: app.SETTINGS.tagMap });
    const rt2 = app.MD.serialise(p2.tasks, { blocks: p2.blocks, eol: p2.eol }, app.SETTINGS);
    add("R12 20k tasks, ~200 completions: reserialise idempotent + count preserved", p2.tasks.length === 20000 && rt2 === rt1, "");
  }

  { // R13: crash thresholds for the serialiser's spread-argument stack overflow
    const findThreshold = (probe, lo, hi) => {
      // probe(n) → true if it crashes; find smallest crashing n by bisection
      if (!probe(hi)) return null;
      while (lo + Math.max(1, Math.floor(lo * 0.02)) < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (probe(mid)) hi = mid; else lo = mid;
      }
      return hi;
    };
    { // a) note lines on a single task (lines.push(...e.lines))
      const probe = n => {
        const app = loadApp();
        const lines = ["## Open", "- [ ] giant ^aaaaaa"];
        for (let i = 0; i < n; i++) lines.push("    n" + i);
        const p = app.MD.parse(lines.join("\n") + "\n", { tagMap: app.SETTINGS.tagMap });
        try { app.MD.serialise(p.tasks, { blocks: p.blocks, eol: p.eol }, app.SETTINGS); return false; } catch (e) { return true; }
      };
      const th = findThreshold(probe, 10000, 300000);
      add("R13a serialise crashes when one task carries ≥ ~" + (th === null ? ">300k (no crash found)" : th) + " continuation lines (note+subtasks)", th === null, "RangeError: max call stack — autosave permanently fails for such a file", th !== null);
      results.robustness[results.robustness.length - 1].threshold = th;
    }
    { // b) pending tasks placed into a new section at once (entries.push(...newEntries)) —
      //   the "Save as new file"/first-connect path with a large in-browser model
      const probe = n => {
        const app = loadApp();
        const tasks = [];
        for (let i = 0; i < n; i++) tasks.push(app.Model.validate({ id: idOf(i), title: "t " + i, tags: [], due: "2026-09-10", priority: 0, done: false, doneAt: null, note: null, subtasks: [], createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }));
        try { app.MD.serialise(tasks, { blocks: [], eol: "\n" }, app.SETTINGS); return false; } catch (e) { return true; }
      };
      const th = findThreshold(probe, 10000, 300000);
      add("R13b serialise crashes when ≥ ~" + (th === null ? ">300k (no crash found)" : th) + " tasks must be placed into one section at once", th === null, "RangeError: max call stack — hits 'Save as new file' / first connect of a big list", th !== null);
      results.robustness[results.robustness.length - 1].threshold = th;
    }
  }
}

/* ---------------- main ---------------- */
const results = { meta: { node: process.version, platform: os.platform() + " " + os.arch(), cpus: os.cpus()[0] && os.cpus()[0].model, date: new Date().toISOString(), quick: QUICK, gcExposed: !!global.gc }, scale: [], subtasksSingle: [], subtasksMany: [], robustness: [] };
if (!global.gc) console.log("note: run with --expose-gc for accurate heap figures");
console.log("engine: node " + process.version + " · " + (results.meta.cpus || "unknown cpu"));

generatorSelfCheck();
scaleSweep(results);
subtaskSweep(results);
robustness(results);

if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log("\nresults written to " + OUT); }
