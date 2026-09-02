#!/usr/bin/env node
/* stress-dom.js — browser-side stress test for Runway's UI.

   Serves runway.html over localhost, seeds N tasks straight into the app's IndexedDB
   (same records Model.load reads), reloads, and measures what a user feels:

     load       navigationStart → first task row painted (full initial render)
     toggle     complete a task via its checkbox → longest main-thread stall after
     search     type a query → longest stall (includes the 100ms debounce burst)
     addTask    type + Enter in the entry row → longest stall
     domNodes   attached DOM element count after render
     jsHeap     JSHeapUsedSize via CDP after load

   The stall metric is the longest requestAnimationFrame gap in a 2.5s window around
   the interaction: every full list re-render blocks the main thread, and this is the
   freeze the user experiences. Baseline rAF gap is reported for calibration.

   Usage: node stress/stress-dom.js [--quick] [--out results.json]
   Requires the globally installed playwright (present in this environment).
*/
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

let pw;
try { pw = require("playwright"); }
catch { pw = require("/opt/node22/lib/node_modules/playwright"); }

const QUICK = process.argv.includes("--quick");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const HTML = fs.readFileSync(path.join(__dirname, "..", "runway.html"));

/* deterministic generator (mirrors stress-node.js, dates relative to real today) */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ("patch review deploy rotate audit backup restore triage escalate verify sign scan build test merge document renew invoice schedule brief firewall sensor endpoint kernel registry cluster tunnel beacon parser sandbox quarantine payload telemetry console dashboard token cert vault").split(" ");
const TAGS = ["DPN", "BSM", "Highside", "ops", "home"];
function isoOffset(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function genTasks(N, opts) {
  opts = opts || {};
  const rnd = mulberry32(opts.seed || 42);
  const doneShare = opts.doneShare || 0;
  const tasks = [];
  for (let i = 0; i < N; i++) {
    const nw = 3 + Math.floor(rnd() * 5);
    let title = [];
    for (let w = 0; w < nw; w++) title.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    const done = rnd() < doneShare;
    const dated = done || rnd() < 0.85;
    const due = dated ? isoOffset(Math.floor(rnd() * 40) - 8) : null; // spread: overdue → +1 month
    const tags = rnd() < 0.5 ? [TAGS[Math.floor(rnd() * TAGS.length)]] : [];
    const subtasks = [];
    const per = opts.subsPerTask || 0;
    for (let s = 0; s < per; s++) subtasks.push({ text: "step " + s, done: s % 2 === 0, due: null });
    tasks.push({
      id: i.toString(36).padStart(6, "0"), title: title.join(" ") + " " + i, tags, due,
      priority: rnd() < 0.15 ? 1 + Math.floor(rnd() * 3) : 0,
      done, doneAt: done ? isoOffset(-Math.floor(rnd() * 20)) : null,
      note: null, subtasks,
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    });
  }
  return tasks;
}

const SEED_JS = async (tasks) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open("runway", 1);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains("tasks")) d.createObjectStore("tasks", { keyPath: "id" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "k" });
      if (!d.objectStoreNames.contains("journal")) d.createObjectStore("journal", { autoIncrement: true });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const t0 = performance.now();
  await new Promise((res, rej) => {
    const tx = db.transaction("tasks", "readwrite");
    const s = tx.objectStore("tasks");
    s.clear();
    for (const t of tasks) s.put(t);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
  return performance.now() - t0;
};

/* longest rAF gap while an interaction runs — the user-felt freeze */
const PROBE_JS = `
window.__probe = (durationMs) => new Promise(res => {
  const gaps = []; let last = performance.now(); const t0 = last;
  function tick() {
    const now = performance.now(); gaps.push(now - last); last = now;
    if (now - t0 < durationMs) requestAnimationFrame(tick);
    else { gaps.sort((a,b)=>b-a); res({ max: gaps[0] || 0, second: gaps[1] || 0 }); }
  }
  requestAnimationFrame(tick);
});`;

async function measureScale(browser, N, opts, label) {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  const server = opts.server;
  const errors = [];
  page.on("pageerror", e => errors.push(String(e && e.message || e)));

  // 1. create DB + seed
  await page.goto(server + "/", { waitUntil: "domcontentloaded" });
  const tasks = genTasks(N, opts);
  const seedMs = await page.evaluate(SEED_JS, tasks);

  // 2. reload; record when the first row (or empty state) hits the DOM.
  //    Observe `document` — documentElement may not exist yet at init-script time.
  await page.addInitScript(`
    new MutationObserver((m, obs) => {
      if (document.querySelector(".task, .empty")) { window.__renderedAt = performance.now(); obs.disconnect(); }
    }).observe(document, { childList: true, subtree: true });`);
  await page.reload({ waitUntil: "commit" });
  const loadMs = await page.evaluate(() => new Promise(res => {
    const t0 = Date.now();
    const check = () => {
      if (window.__renderedAt !== undefined) return res(window.__renderedAt);
      if (document.querySelector(".task, .empty")) return res(performance.now()); // observer fallback
      if (Date.now() - t0 > 240000) return res(-1);
      setTimeout(check, 50);
    };
    check();
  }));
  if (loadMs === -1) throw new Error("render never completed within 240s");
  await page.evaluate(PROBE_JS);
  const baseline = await page.evaluate(() => window.__probe(400));

  const rows = await page.evaluate(() => document.querySelectorAll(".task").length);
  const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);

  // 3. interactions
  const toggle = await page.evaluate(async () => {
    const p = window.__probe(2500);
    const cb = document.querySelector(".task .cb");
    if (cb) cb.click();
    return await p;
  });
  const search = await page.evaluate(async () => {
    const p = window.__probe(2500);
    const si = document.getElementById("searchInput");
    si.value = "patch"; si.dispatchEvent(new Event("input", { bubbles: true }));
    return await p;
  });
  await page.evaluate(() => { const si = document.getElementById("searchInput"); si.value = ""; si.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(300);
  const addTask = await page.evaluate(async () => {
    const p = window.__probe(2500);
    const ti = document.getElementById("titleInput");
    ti.focus(); ti.value = "stress added task tomorrow check";
    ti.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return await p;
  });

  // 4. heap
  let heapMB = null;
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const m = await cdp.send("Performance.getMetrics");
    const heap = m.metrics.find(x => x.name === "JSHeapUsedSize");
    heapMB = heap ? Math.round(heap.value / 1048576 * 10) / 10 : null;
  } catch (e) { /* CDP optional */ }

  await context.close();
  const r = (v) => Math.round(v);
  const row = {
    label: label || String(N), tasks: N, openRendered: rows, seedMs: r(seedMs), loadMs: r(loadMs),
    baselineGapMs: r(baseline.max), toggleStallMs: r(toggle.max), searchStallMs: r(search.max),
    addTaskStallMs: r(addTask.max), domNodes, heapMB, pageErrors: errors,
  };
  console.log(
    String(row.label).padEnd(16) + String(rows).padEnd(9) + String(row.loadMs).padEnd(9) +
    String(row.toggleStallMs).padEnd(9) + String(row.searchStallMs).padEnd(9) + String(row.addTaskStallMs).padEnd(9) +
    String(domNodes).padEnd(10) + String(heapMB === null ? "?" : heapMB).padEnd(9) + String(row.baselineGapMs).padEnd(6) +
    (errors.length ? " ERRORS: " + errors.join(" | ").slice(0, 120) : "")
  );
  return row;
}

(async () => {
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(HTML); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;

  // --no-sandbox: required in rootful containers/CI; harmless for a localhost-only page
  const browser = await pw.chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const results = { meta: { chromium: browser.version(), date: new Date().toISOString(), quick: QUICK }, runs: [] };
  console.log("chromium " + browser.version() + " · serving runway.html at " + base);
  console.log("\nscenario        rows     load     toggle   search   addTask  nodes     heapMB   base");

  const SCALES = QUICK ? [100, 1000, 5000] : [100, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  for (const N of SCALES) {
    try { results.runs.push(await measureScale(browser, N, { server: base }, N + " open")); }
    catch (e) { console.log(N + " open: FAILED — " + (e && e.message || e).slice(0, 200)); results.runs.push({ label: N + " open", tasks: N, failed: String(e && e.message || e) }); break; }
  }
  // mixed shape: mostly completed — parse cost stays, DOM cost drops (completed list is capped)
  if (!QUICK) {
    try { results.runs.push(await measureScale(browser, 20000, { server: base, doneShare: 0.95 }, "20k, 5% open")); } catch (e) { console.log("mixed: FAILED — " + e.message); }
    try { results.runs.push(await measureScale(browser, 1000, { server: base, subsPerTask: 10 }, "1k ×10 subs")); } catch (e) { console.log("subs: FAILED — " + e.message); }
  }

  await browser.close();
  server.close();
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log("\nresults written to " + OUT); }
})().catch(e => { console.error(e); process.exit(1); });
