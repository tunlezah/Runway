#!/usr/bin/env node
/* robust-browser.js — failure-injection checks against the real Runway UI in headless Chromium.

   Serves runway.html over localhost (a secure context, so the Origin Private File System
   can stand in for a real todo.md: the app is handed an OPFS file handle through the same
   IndexedDB record it would store after "Choose todo.md"). Every scenario runs in a fresh
   browser context. Confirm dialogs are auto-accepted. Page errors are collected throughout.

     S1  corrupt stored record   a completed task with an unreadable completion date
     S2  two tabs, one file       the same list open twice: a write in one tab, then an action
                                  in the other — with and without the second tab regaining focus
     S3  IME composition          Enter that confirms a composition (isComposing) in the entry box
     S4  Space on a focused button while a task is selected
     S5  double Enter             two Enter keydowns before the first add has cleared the box
     S6  non-UTF-8 file           a Latin-1 todo.md connected and then saved
     S7  settings import          hostile / non-object JSON through the real import control
     S8  scripted session         add, complete, undo/redo, snooze, views, drag, search, panels,
                                  help tabs, export, #test — expecting zero page errors
     S9  storage failure          IndexedDB blocked at boot; a put() that throws quota errors
     S10 unload with autosave pending
     S11 external edit            reload when clean, conflict when dirty
     S12 undo after a reload      undo of a pre-reload action against an externally edited task
     S13 malformed stored id      a record whose id is not in the app's format, then an edit
     S14 first-connect banner     a task typed / Ctrl+S / tab hidden while the banner asks what to keep,
                                  and a first read that fails: nothing may be written (audit B1)
     S15 write in flight          a change committed while an autosave is writing stays marked unsaved
                                  and reaches the file, also across a reload (audit B2)
     S16 import of an old export  a task the app already has is not reverted; the import is undoable (B3)
     S17 Firefox/Safari export    the imported file's headings and prose survive a reload (audit B4)

   The checks assert the intended behaviour, so a scenario that reports a FINDING on one
   version and behaves on the next is a fix landing.

   Usage: node stress/robust-browser.js [--only S2,S8] [--out results.json] [--fail-on-new]
   --fail-on-new exits 1 on any harness error or on a finding outside the documented open Lows
   (S4, S5, S7b, S13 — report findings R8, R9, R12, R4), so CI fails only on new regressions.
   Symbols: ✓ behaved · ⚠ FINDING defect demonstrated · ✗ harness error
*/
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

let pw;
try { pw = require("playwright"); } catch { pw = require("/opt/node22/lib/node_modules/playwright"); }

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const ONLY = (arg("--only", "") || "").split(",").filter(Boolean);
const OUT = arg("--out", null);
const FAIL_ON_NEW = process.argv.includes("--fail-on-new");
const KNOWN_OPEN = /^S(4|5|7b|13) /; // documented, not yet fixed Low findings (docs/robustness-check-report.md R8, R9, R12, R4)
const HTML = fs.readFileSync(path.join(__dirname, "..", "runway.html"));

const results = { meta: { date: new Date().toISOString() }, checks: [] };
let findings = 0;
const report = (name, ok, detail, finding) => {
  if (!ok && finding) findings++;
  console.log("  " + (ok ? "✓" : finding ? "⚠ FINDING" : "✗") + " " + name + (detail ? " — " + detail : ""));
  results.checks.push({ name, ok, finding: !ok && !!finding, detail: detail || "" });
};

/* ---------------- helpers installed in every page (window.__rw) ---------------- */
const PAGE_HELPERS = `window.__rw = (() => {
  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open("runway", 1);
    r.onupgradeneeded = e => { const d = e.target.result;
      if (!d.objectStoreNames.contains("tasks")) d.createObjectStore("tasks", { keyPath: "id" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "k" });
      if (!d.objectStoreNames.contains("journal")) d.createObjectStore("journal", { autoIncrement: true }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const root = () => navigator.storage.getDirectory();
  return {
    async seed({ tasks, meta }) {
      const db = await openDb();
      await new Promise((res, rej) => {
        const tx = db.transaction(["tasks", "meta"], "readwrite");
        for (const t of tasks || []) tx.objectStore("tasks").put(t);
        for (const m of meta || []) tx.objectStore("meta").put(m);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    async connectOpfs({ name, bytes }) {
      const fh = await (await root()).getFileHandle(name, { create: true });
      if (bytes) { const w = await fh.createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
      const db = await openDb();
      await new Promise((res, rej) => {
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ k: "fileHandle", v: fh });
        tx.objectStore("meta").delete("fileMeta");
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    async readOpfs(name) {
      const fh = await (await root()).getFileHandle(name);
      // The app writes atomically (temp file, then swap). A File snapshot taken just before the swap reads as
      // NotReadableError ("permission problems that have occurred after a reference to a file was acquired"), so a
      // poll that lands on the swap must take a fresh snapshot rather than fail the scenario.
      for (let attempt = 0; ; attempt++) {
        try { return Array.from(new Uint8Array(await (await fh.getFile()).arrayBuffer())); }
        catch (e) { if (attempt < 40 && e && e.name === "NotReadableError") { await new Promise((r) => setTimeout(r, 25)); continue; } throw e; }
      }
    },
    async writeOpfs({ name, text }) {
      const fh = await (await root()).getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(text); await w.close();
    },
    async idbAll(store) {
      const db = await openDb();
      const out = await new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      db.close();
      return out;
    },
    titles: () => Array.from(document.querySelectorAll("#listRoot .task .title, #listRoot .bcard .title")).map(e => e.textContent),
    doneTitles: () => Array.from(document.querySelectorAll("#completedRoot .task .title")).map(e => e.textContent),
    banners: () => Array.from(document.querySelectorAll("#banners .banner")).map(b => ({ id: b.dataset.bid, text: b.querySelector(".msg") && b.querySelector(".msg").textContent })),
    saveState: () => { const s = document.getElementById("saveInd"); return s.hidden ? "hidden" : s.className.replace("save-ind", "").trim() || "clean"; },
  };
})();`;

const rw = {
  seed: (page, a) => page.evaluate((x) => window.__rw.seed(x), a),
  connectOpfs: (page, a) => page.evaluate((x) => window.__rw.connectOpfs(x), a),
  readOpfs: (page, name) => page.evaluate((x) => window.__rw.readOpfs(x), name),
  writeOpfs: (page, a) => page.evaluate((x) => window.__rw.writeOpfs(x), a),
  idbAll: (page, store) => page.evaluate((x) => window.__rw.idbAll(x), store),
  titles: (page) => page.evaluate(() => window.__rw.titles()),
  doneTitles: (page) => page.evaluate(() => window.__rw.doneTitles()),
  banners: (page) => page.evaluate(() => window.__rw.banners()),
  saveState: (page) => page.evaluate(() => window.__rw.saveState()),
  focusEvent: (page) => page.evaluate(() => window.dispatchEvent(new Event("focus"))),
};

const utf8 = (bytes) => Buffer.from(bytes).toString("utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = "#listRoot .task, #listRoot .empty, .bcol, .cal";

async function openApp(context, base, opts) {
  opts = opts || {};
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String((e && e.message) || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  page.on("dialog", (d) => d.accept());
  if (opts.init) await page.addInitScript(opts.init);
  await page.addInitScript(PAGE_HELPERS);
  await page.goto(base + (opts.hash || ""), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(READY, { timeout: 20000 });
  return { page, errors };
}
async function reload(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(READY, { timeout: 20000 });
}
async function waitClean(page, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if ((await rw.saveState(page)) === "clean") return true;
    await sleep(100);
  }
  return false;
}
async function waitBanner(page, id, ms) {
  const t0 = Date.now();
  let bn = [];
  while (Date.now() - t0 < (ms || 6000)) { bn = await rw.banners(page); if (bn.some((b) => b.id === id)) return bn; await sleep(100); }
  return bn;
}
async function addTask(page, title, date, expect) {
  await page.fill("#titleInput", title);
  if (date) await page.fill("#dateInput", date);
  await page.press(date ? "#dateInput" : "#titleInput", "Enter");
  await page.waitForFunction((t) => Array.from(document.querySelectorAll("#listRoot .title")).some((e) => e.textContent === t), expect || title);
}
const blurEntry = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur());
const task = (id, title, extra) => Object.assign({ id, title, tags: [], due: null, priority: 0, done: false, doneAt: null, note: null, subtasks: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }, extra || {});
const FILE = (lines) => "# To Do\n\n## Open\n" + lines.join("\n") + "\n";
const bytesOf = (s) => Array.from(Buffer.from(s));

/* ---------------- scenarios ---------------- */
const scenarios = {
  async S1(browser, base) {
    console.log("\nS1 corrupt stored record (done task with doneAt \"garbage\")");
    const ctx = await browser.newContext();
    const { page, errors } = await openApp(ctx, base);
    await rw.seed(page, { tasks: [task("aaaaa1", "Healthy open task", { due: "2030-01-01" }), task("aaaaa2", "Broken completed task", { done: true, doneAt: "garbage" })] });
    await reload(page);
    const bootTitles = await rw.titles(page);
    const quar = (await rw.banners(page)).filter((b) => b.id === "quar");
    await page.click("#completedToggle");
    await sleep(500);
    const after = await rw.titles(page);
    const doneShown = await rw.doneTitles(page);
    report("S1a the record is quarantined or repaired at load", errors.length === 0 && (quar.length === 1 || doneShown.includes("Broken completed task")), quar.length ? quar[0].text : doneShown.includes("Broken completed task") ? "repaired: the completed list shows it with a valid date" : "neither quarantined nor shown" + (errors.length ? "; " + errors[0] : ""), true);
    report("S1b showing completed tasks keeps the app alive", after.length === bootTitles.length && errors.length === 0, "open rows before/after: " + bootTitles.length + "/" + after.length + ", completed rows: " + doneShown.length + (errors.length ? "; " + errors[0] : ""), true);
    errors.length = 0;
    await page.click("#statsBtn");
    await sleep(500);
    const statsOpen = await page.$(".panel");
    report("S1c the stats panel opens", !!statsOpen && errors.length === 0, errors[0] || "", true);
    if (statsOpen) await page.keyboard.press("Escape");
    errors.length = 0;
    await page.fill("#searchInput", "is:done");
    await sleep(600);
    const rows = await page.evaluate(() => document.querySelectorAll("#listRoot .task").length);
    report("S1d searching is:done lists completed tasks", rows >= 1 && errors.length === 0, "rows " + rows + (errors.length ? "; " + errors[0] : ""), true);
    errors.length = 0;
    await page.fill("#searchInput", "");
    await page.keyboard.press("Escape");
    await sleep(400);
    let added = false;
    try { await addTask(page, "Added after the crash", "2030-02-02"); added = true; } catch (e) { /* never rendered */ }
    const rowsAfter = await page.evaluate(() => document.querySelectorAll("#listRoot .task").length);
    const idb = await rw.idbAll(page, "tasks");
    report("S1e the list keeps working while the completed view is open", added && errors.length === 0, "new task rendered: " + added + " (stored in IndexedDB: " + idb.some((t) => t.title === "Added after the crash") + "), open rows shown: " + rowsAfter + (errors.length ? "; " + errors[0] + " — no error banner, no recovery path short of a reload" : ""), true);
    await ctx.close();
  },

  async S2(browser, base) {
    console.log("\nS2 two tabs on the same list and file");
    for (const variant of ["second tab acts before any focus event", "second tab regains focus first"]) {
      const ctx = await browser.newContext();
      const A = await openApp(ctx, base);
      await rw.connectOpfs(A.page, { name: "todo.md", bytes: bytesOf(FILE(["- [ ] Base task 📅 2030-01-01 ^b00001"])) });
      await reload(A.page);
      await waitClean(A.page);
      const B = await openApp(ctx, base);
      await waitClean(B.page);
      const bTitles0 = await rw.titles(B.page);
      await addTask(A.page, "Added in tab A", "2030-02-02");
      await waitClean(A.page);
      const file1 = utf8(await rw.readOpfs(A.page, "todo.md"));
      const step1 = file1.includes("Added in tab A") && bTitles0.length === 1;
      if (variant === "second tab regains focus first") {
        await rw.focusEvent(B.page);
        await sleep(800);
        const bTitles = await rw.titles(B.page);
        const bn = await rw.banners(B.page);
        report("S2 " + variant + ": tab B picks up tab A's task", step1 && bTitles.includes("Added in tab A"), "B shows " + JSON.stringify(bTitles) + "; banners: " + JSON.stringify(bn.map((b) => b.id)), true);
        await ctx.close();
        continue;
      }
      // B acts on whatever it has, with no focus/visibility event in between
      await B.page.click('#listRoot .task[data-id="b00001"] .cb');
      const t0 = Date.now();
      let bn = [];
      while (Date.now() - t0 < 8000) {
        bn = await rw.banners(B.page);
        if (bn.some((b) => b.id === "conflict")) break;
        if (Date.now() - t0 > 1500 && (await rw.saveState(B.page)) === "clean") break;
        await sleep(100);
      }
      const conflict = bn.find((b) => b.id === "conflict");
      if (!conflict) {
        const file2 = utf8(await rw.readOpfs(B.page, "todo.md"));
        const hasA = file2.includes("Added in tab A"), hasB = /- \[x\] Base task/.test(file2);
        report("S2 " + variant + ": both tabs' work reaches the file, no conflict raised", step1 && hasA && hasB, "file has tab A's task: " + hasA + ", tab B's completion: " + hasB + "; banners: " + JSON.stringify(bn.map((b) => b.id)), true);
        await rw.focusEvent(A.page);
        await sleep(1200);
        const aTitles = await rw.titles(A.page);
        const idb = await rw.idbAll(A.page, "tasks");
        report("S2 " + variant + ": tab A shows tab B's completion and nothing is lost", !aTitles.includes("Base task") && aTitles.includes("Added in tab A") && idb.length === 2, "A shows " + JSON.stringify(aTitles) + "; IndexedDB holds " + idb.length + " tasks", true);
        await ctx.close();
        continue;
      }
      const hasKeepBoth = await B.page.$('#banners .banner[data-bid="conflict"] button:has-text("Keep both")');
      report("S2 " + variant + ": if a conflict is raised it offers Keep both (no forced data loss)", !!hasKeepBoth, "banner reads: " + JSON.stringify(conflict.text) + "; Keep both offered: " + !!hasKeepBoth, true);
      await B.page.click('#banners .banner[data-bid="conflict"] button:has-text("Keep my version")');
      await waitClean(B.page);
      const file2 = utf8(await rw.readOpfs(B.page, "todo.md"));
      const lostInFile = !file2.includes("Added in tab A");
      await rw.focusEvent(A.page);
      await sleep(1200);
      const aTitles = await rw.titles(A.page);
      const idb = await rw.idbAll(A.page, "tasks");
      const lostEverywhere = lostInFile && !aTitles.includes("Added in tab A") && !idb.some((t) => t.title === "Added in tab A");
      report("S2 " + variant + ": choosing \"Keep my version\" in tab B keeps tab A's task", !lostInFile, lostInFile ? "tab A's task is gone from the file" + (lostEverywhere ? "; after tab A regains focus it is gone from tab A and from IndexedDB too — loss through in-app actions only" : "") : "kept", true);
      await ctx.close();
    }
  },

  async S3(browser, base) {
    console.log("\nS3 IME composition: Enter that confirms a composition");
    const ctx = await browser.newContext();
    const { page } = await openApp(ctx, base);
    await page.fill("#titleInput", "日本語のタスク");
    await page.evaluate(() => {
      const ti = document.getElementById("titleInput");
      ti.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true }));
    });
    await sleep(400);
    const titles = await rw.titles(page);
    const value = await page.inputValue("#titleInput");
    report("S3 a composing Enter does not add the task", !titles.includes("日本語のタスク") && value === "日本語のタスク", titles.includes("日本語のタスク") ? "task added and the entry box cleared (value now " + JSON.stringify(value) + ") while the IME was still composing" : "ignored; the box still holds the composition", true);
    await page.press("#titleInput", "Enter");
    await sleep(400);
    const titles2 = await rw.titles(page);
    report("S3b a real Enter afterwards adds it", titles2.includes("日本語のタスク"), JSON.stringify(titles2), true);
    await ctx.close();
  },

  async S4(browser, base) {
    console.log("\nS4 Space on a focused row button while a task is selected");
    const ctx = await browser.newContext();
    const { page } = await openApp(ctx, base);
    await rw.seed(page, { tasks: [task("s4aaa1", "Selected task", { due: "2030-01-01" }), task("s4aaa2", "Other task", { due: "2030-01-02" })] });
    await reload(page);
    await page.keyboard.press("j");
    const sel = await page.evaluate(() => (document.querySelector("#listRoot .task.sel .title") || {}).textContent);
    await page.evaluate(() => document.querySelector('#listRoot .task[data-id="s4aaa1"] .rowactions button[title="Snooze"]').focus());
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.title);
    await page.keyboard.press("Space");
    await sleep(600);
    const pop = await page.$(".pop");
    const titles = await rw.titles(page);
    report("S4 Space activates the focused button (snooze menu) rather than completing the task", !!pop && titles.includes("Selected task"), "selected " + JSON.stringify(sel) + ", focused button " + JSON.stringify(focused) + "; snooze menu open: " + !!pop + "; open rows now: " + JSON.stringify(titles), true);
    await ctx.close();
  },

  async S5(browser, base) {
    console.log("\nS5 two Enter presses before the first add clears the box");
    const ctx = await browser.newContext();
    const { page } = await openApp(ctx, base);
    await page.fill("#titleInput", "Pressed twice");
    await page.evaluate(() => {
      const ti = document.getElementById("titleInput");
      const ev = () => new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true });
      ti.dispatchEvent(ev()); ti.dispatchEvent(ev());
    });
    await sleep(800);
    const n = (await rw.titles(page)).filter((t) => t === "Pressed twice").length;
    report("S5 one task is added", n === 1, n + " tasks titled \"Pressed twice\"", true);
    await ctx.close();
  },

  async S6(browser, base) {
    console.log("\nS6 a Latin-1 (non-UTF-8) todo.md");
    const ctx = await browser.newContext();
    const { page } = await openApp(ctx, base);
    const latin1 = Buffer.from("# To Do\n\n## Open\n- [ ] Caf\xe9 cr\xe8me ^c0ffee\n\n## Notes\nPr\xe9face: ne pas toucher.\n", "latin1");
    await rw.connectOpfs(page, { name: "todo.md", bytes: Array.from(latin1) });
    await reload(page);
    await waitClean(page, 2500);
    const titles = await rw.titles(page);
    const bn = await rw.banners(page);
    await addTask(page, "Trigger a save", "2030-03-03");
    await waitClean(page, 3000);
    const after = Buffer.from(await rw.readOpfs(page, "todo.md"));
    const replaced = after.includes(Buffer.from([0xef, 0xbf, 0xbd]));
    const kept = after.equals(latin1);
    report("S6a the app says the file is not UTF-8 instead of showing replacement characters", bn.some((b) => /utf-?8/i.test(b.text || "")) && !titles.some((t) => /�/.test(t)), "banners: " + JSON.stringify(bn.map((b) => b.text && b.text.slice(0, 90))) + "; titles shown: " + JSON.stringify(titles), true);
    report("S6b the file is left byte-for-byte alone after a change in the app", kept && !replaced, replaced ? "the file was rewritten as UTF-8 with U+FFFD (EF BF BD) in place of every accented byte, including the '## Notes' prose" : kept ? "untouched" : "changed", true);
    // convert the file to UTF-8 outside the app, then "Check again"
    await rw.writeOpfs(page, { name: "todo.md", text: "# To Do\n\n## Open\n- [ ] Café crème ^c0ffee\n\n## Notes\nPréface: ne pas toucher.\n" });
    const again = await page.$('#banners .banner button:has-text("Check again")');
    if (again) await again.click();
    // the app's task lived only in the browser while the file was unreadable; connecting the now-readable file
    // offers the first-connect chooser rather than silently dropping either side — Keep both keeps everything
    const kb = await waitBanner(page, "conflict", 3000);
    const keepBoth = kb.some((b) => b.id === "conflict") ? await page.$('#banners .banner[data-bid="conflict"] button:has-text("Keep both")') : null;
    if (keepBoth) await keepBoth.click();
    await waitClean(page, 6000);
    const file3 = utf8(await rw.readOpfs(page, "todo.md"));
    const t3 = await rw.titles(page);
    report("S6c after the file is converted, the browser task and the file's tasks are both kept, prose intact", t3.includes("Café crème") && t3.includes("Trigger a save") && file3.includes("Trigger a save") && file3.includes("Préface"), "Keep both offered: " + !!keepBoth + "; titles " + JSON.stringify(t3) + "; file has the app's task: " + file3.includes("Trigger a save") + ", prose intact: " + file3.includes("Préface"), true);
    await ctx.close();
  },

  async S7(browser, base) {
    console.log("\nS7 settings import with hostile or non-object JSON");
    const ctx = await browser.newContext();
    const { page, errors } = await openApp(ctx, base);
    const importJson = async (json) => {
      await page.click("#settingsBtn");
      await page.waitForSelector(".panel");
      const input = await page.$('.panel input[type="file"][accept=".json"]');
      await input.setInputFiles({ name: "settings.json", mimeType: "application/json", buffer: Buffer.from(json) });
      await sleep(600);
      if (await page.$(".panel")) { await page.keyboard.press("Escape"); await sleep(200); }
    };
    await importJson(JSON.stringify({ __proto__: { polluted: true }, tagMap: { __proto__: "x", constructor: "y", d: "OK", zz: "ZZ" }, urgency: { soon: "a", near: 1 }, theme: "dark", autosaveDebounceMs: 1e9, workWeek: [9, "x"] }));
    const polluted = await page.evaluate(() => ({}).polluted !== undefined || Object.prototype.polluted !== undefined);
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await addTask(page, "Still working after import", "tom");
    report("S7a hostile keys do not pollute Object.prototype and the app keeps working", !polluted && errors.length === 0, "polluted=" + polluted + ", theme applied=" + theme + (errors.length ? "; " + errors[0] : ""), true);
    await importJson("null");
    const themeAfterNull = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const bn1 = await rw.banners(page);
    report("S7b importing a non-object JSON (\"null\") is refused instead of resetting every setting", themeAfterNull === "dark", "theme was dark, now " + JSON.stringify(themeAfterNull) + " (all settings silently reset to defaults); banners: " + JSON.stringify(bn1.map((b) => b.id)), true);
    await importJson("{not json");
    const bn2 = await rw.banners(page);
    report("S7c invalid JSON shows the 'couldn't be read' banner", bn2.some((b) => b.id === "setimp"), JSON.stringify(bn2.map((b) => b.id)), false);
    await ctx.close();
  },

  async S8(browser, base) {
    console.log("\nS8 scripted session, watching for page errors");
    const ctx = await browser.newContext();
    const { page, errors } = await openApp(ctx, base);
    await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(FILE(["- [ ] Seeded task 📅 2030-01-01 ^s33d01"])) });
    await reload(page);
    await waitClean(page);
    await addTask(page, "Plain task");
    await addTask(page, "Tagged [d] and urgent !!!", "tom", "Tagged and urgent");
    await addTask(page, "Dated +2w task #Ops", "+2w", "Dated +2w task");
    await addTask(page, "Typed with a date 📅 2030-06-06 inside", undefined, "Typed with a date inside");
    await blurEntry(page);
    await page.click("#listRoot .task .cb");
    await sleep(600);
    await page.keyboard.press("Control+z");
    await sleep(300);
    await page.keyboard.press("Control+Shift+z");
    await sleep(300);
    await page.keyboard.press("Control+z");
    await sleep(300);
    await page.keyboard.press("j");
    await page.keyboard.press(".");
    await page.waitForSelector(".pop");
    await page.keyboard.press("1");
    await sleep(300);
    await page.keyboard.press("j");
    await page.keyboard.press("!");
    await sleep(200);
    await page.keyboard.press("s");
    await page.waitForSelector(".sub-add");
    await page.fill(".sub-add", "a sub-task 📅 2030-05-05");
    await page.press(".sub-add", "Enter");
    await sleep(300);
    await page.keyboard.press("Escape");
    await page.keyboard.press("v"); // board
    await page.waitForSelector(".bcol");
    if (await page.$(".bcard")) { try { await page.dragAndDrop(".bcard", '.bcol[data-col="later"] .bcol-list'); } catch (e) { errors.push("dragAndDrop: " + e.message); } }
    await sleep(400);
    await page.keyboard.press("v"); // calendar
    await page.waitForSelector(".cal");
    await page.click(".cal-nav >> nth=1");
    await page.click(".cal-nav >> nth=0");
    await page.click(".cal-day .cal-num >> nth=10");
    await sleep(200);
    await page.keyboard.press("Escape");
    await page.keyboard.press("v"); // list
    await page.keyboard.press("/");
    await page.keyboard.type("task -#ops due:<400d");
    await sleep(400);
    await page.keyboard.press("Escape");
    await page.click("#statsBtn"); await page.waitForSelector(".panel"); await page.keyboard.press("Escape");
    await page.click("#settingsBtn"); await page.waitForSelector(".panel");
    await page.click('.panel .seg-btns button:has-text("Work days")');
    await page.click('.panel .seg-btns button:has-text("Bracket")');
    await page.keyboard.press("Escape");
    await page.keyboard.press("?"); await page.waitForSelector(".shortcuts"); await page.keyboard.press("Escape");
    await page.click("#helpBtn"); await page.waitForSelector(".shortcuts.help"); // every help tab, by click and by arrow key
    for (const tab of ["entry", "list", "search", "keys", "file", "start"]) await page.click(`.help-tabs [data-tab="${tab}"]`);
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Home"); await page.click(".help-next"); await page.keyboard.press("Escape");
    await page.click("#completedToggle");
    const dl = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
    await page.keyboard.press("Control+s");
    const download = await dl;
    await waitClean(page);
    const file = utf8(await rw.readOpfs(page, "todo.md"));
    await page.goto(base + "#test", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#testpanel strong", { timeout: 60000 });
    const testLine = await page.textContent("#testpanel strong");
    report("S8a no page errors across the scripted session", errors.length === 0, errors.length ? errors.slice(0, 3).join(" | ") : "add/complete/undo/redo/snooze/priority/sub-task/board drag/calendar/search/stats/settings/shortcuts/help tabs/completed/export", true);
    report("S8b the file reflects the session and keeps the seeded line verbatim", file.includes("a sub-task") && file.includes("Plain task") && file.includes("Dated +2w task") && file.includes("- [ ] Seeded task 📅 2030-01-01 ^s33d01"), file.split("\n").slice(0, 12).join(" ⏎ ").slice(0, 300), true);
    report("S8c a 📅 date typed into a title is stored as the due date, not left as title text", /Typed with a date inside (📅 |\[due:: )2030-06-06/.test(file) && !/Typed with a date inside 📅 2030-06-06 📅/.test(file), (file.split("\n").find((l) => l.includes("Typed with a date")) || "line not found"), true);
    report("S8d Ctrl+S with a connected file writes the file (no download)", download === null, download ? "a download was triggered instead" : "", false);
    report("S8e embedded suite passes in the browser", /^\d+ \/ \d+ passed$/.test(testLine || "") && testLine.split(" / ")[0] === testLine.split(" / ")[1].split(" ")[0], testLine || "", true);
    await ctx.close();
  },

  async S9(browser, base) {
    console.log("\nS9 storage failures");
    {
      const ctx = await browser.newContext();
      const { page, errors } = await openApp(ctx, base, { init: () => { Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("blocked", "SecurityError"); } }); } });
      const bn = await rw.banners(page);
      await addTask(page, "Memory only task");
      report("S9a IndexedDB throwing at boot → tier-3 banner and a working in-memory list", bn.some((b) => b.id === "tier3") && errors.length === 0, JSON.stringify(bn.map((b) => b.id)) + (errors.length ? "; " + errors[0] : ""), true);
      await ctx.close();
    }
    {
      const ctx = await browser.newContext();
      const { page, errors } = await openApp(ctx, base, { init: () => { const orig = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { if (this.name === "tasks") throw new DOMException("QuotaExceededError", "QuotaExceededError"); return orig.apply(this, arguments); }; } });
      await addTask(page, "Quota task");
      await sleep(300);
      const bn = await rw.banners(page);
      const titles = await rw.titles(page);
      report("S9b a QuotaExceededError on put() → storage-full banner, task kept in memory", bn.some((b) => b.id === "dberr" && /full/i.test(b.text)) && titles.includes("Quota task") && errors.length === 0, JSON.stringify(bn.map((b) => b.text && b.text.slice(0, 60))) + (errors.length ? "; " + errors[0] : ""), true);
      await ctx.close();
    }
  },

  async S10(browser, base) {
    console.log("\nS10 closing the tab while an autosave is pending");
    const ctx = await browser.newContext();
    const { page } = await openApp(ctx, base);
    await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(FILE(["- [ ] Base task 📅 2030-01-01 ^b00001"])) });
    await rw.seed(page, { meta: [{ k: "settings", v: { schemaVersion: 1, autosaveDebounceMs: 60000 } }] });
    await reload(page);
    await waitClean(page);
    await addTask(page, "Added just before closing", "2030-04-04");
    const st = await rw.saveState(page);
    await page.close();
    const p2 = await openApp(ctx, base);
    await waitClean(p2.page, 8000);
    const titles = await rw.titles(p2.page);
    const file = utf8(await rw.readOpfs(p2.page, "todo.md"));
    report("S10 the pending change survives the close and reaches the file on the next launch", titles.includes("Added just before closing") && file.includes("Added just before closing"), "state at close: " + st + "; after relaunch: in list=" + titles.includes("Added just before closing") + ", in file=" + file.includes("Added just before closing"), true);
    await ctx.close();
  },

  async S11(browser, base) {
    console.log("\nS11 external edits");
    const ctx = await browser.newContext();
    const { page, errors } = await openApp(ctx, base);
    await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(FILE(["- [ ] Base task 📅 2030-01-01 ^b00001"])) });
    await reload(page);
    await waitClean(page);
    await sleep(50);
    await rw.writeOpfs(page, { name: "todo.md", text: FILE(["- [ ] Base task 📅 2030-01-01 ^b00001", "- [ ] Edited in vim 📅 2030-01-02 ^v1m001"]) });
    await rw.focusEvent(page);
    await sleep(800);
    const titles = await rw.titles(page);
    const bn = await rw.banners(page);
    report("S11a a clean app reloads an external edit and says so", titles.includes("Edited in vim") && bn.some((b) => b.id === "reloaded"), JSON.stringify(titles) + " " + JSON.stringify(bn.map((b) => b.id)), true);
    await rw.seed(page, { meta: [{ k: "settings", v: { schemaVersion: 1, autosaveDebounceMs: 60000 } }] });
    await reload(page);
    await waitClean(page);
    await addTask(page, "Unsaved in app", "2030-01-03");
    await rw.writeOpfs(page, { name: "todo.md", text: FILE(["- [ ] Base task 📅 2030-01-01 ^b00001", "- [ ] Edited in vim 📅 2030-01-02 ^v1m001", "- [ ] Second external edit ^v1m002"]) });
    await rw.focusEvent(page);
    await sleep(800);
    const bn2 = await rw.banners(page);
    const file = utf8(await rw.readOpfs(page, "todo.md"));
    report("S11b with unsaved changes an external edit raises the conflict banner and the file is untouched", bn2.some((b) => b.id === "conflict") && file.includes("Second external edit") && !file.includes("Unsaved in app"), JSON.stringify(bn2.map((b) => b.id)), true);
    const keepBoth = await page.$('#banners .banner[data-bid="conflict"] button:has-text("Keep both")');
    if (keepBoth) { await keepBoth.click(); await waitClean(page, 8000); }
    const file2 = utf8(await rw.readOpfs(page, "todo.md"));
    report("S11c the conflict banner offers Keep both, which merges the file's tasks with the app's new one", !!keepBoth && file2.includes("Second external edit") && file2.includes("Unsaved in app") && file2.includes("Edited in vim"), keepBoth ? "after Keep both the file has all of: external edit " + file2.includes("Second external edit") + ", app task " + file2.includes("Unsaved in app") : "no Keep both button", true);
    report("S11d no page errors", errors.length === 0, errors[0] || "", true);
    await ctx.close();
  },

  async S12(browser, base) {
    console.log("\nS12 undo after an external reload");
    const ctx = await browser.newContext();
    const { page } = await openApp(ctx, base);
    await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(FILE(["- [ ] Base task 📅 2030-01-01 ^b00001"])) });
    await reload(page);
    await waitClean(page);
    await addTask(page, "Ephemeral", "2030-01-05");
    await waitClean(page);
    const file1 = utf8(await rw.readOpfs(page, "todo.md"));
    const id = (/- \[ \] Ephemeral 📅 2030-01-05 \^([0-9a-z]{6})/.exec(file1) || [])[1];
    await rw.writeOpfs(page, { name: "todo.md", text: file1.replace("Ephemeral", "Renamed in an editor, hours of notes") });
    await rw.focusEvent(page);
    await sleep(800);
    const t1 = await rw.titles(page);
    await blurEntry(page); // Ctrl+Z inside a text field is left to the browser; undo the app's history instead
    await page.keyboard.press("Control+z");
    await sleep(400);
    await waitClean(page);
    const t2 = await rw.titles(page);
    const file2 = utf8(await rw.readOpfs(page, "todo.md"));
    report("S12 undo after a reload does not act on stale history", t2.includes("Renamed in an editor, hours of notes") && file2.includes("Renamed in an editor"), "id " + id + "; after reload: " + JSON.stringify(t1) + "; after Ctrl+Z (undo of the pre-reload 'add'): " + JSON.stringify(t2) + "; the external rename survives in the file: " + file2.includes("Renamed in an editor"), true);
    await ctx.close();
  },

  async S13(browser, base) {
    console.log("\nS13 a stored record whose id is not in the app's format");
    const ctx = await browser.newContext();
    const { page } = await openApp(ctx, base);
    await rw.seed(page, { tasks: [task("BAD-ID", "Odd id task", { due: "2030-01-01" })] });
    await reload(page);
    const t1 = await rw.titles(page);
    await page.keyboard.press("j");
    await page.keyboard.press("e");
    await page.waitForSelector(".title-edit");
    await page.fill(".title-edit", "Odd id task renamed");
    await page.press(".title-edit", "Enter");
    await sleep(400);
    const idb1 = await rw.idbAll(page, "tasks");
    await reload(page);
    const t2 = await rw.titles(page);
    report("S13 repairing a malformed id does not leave a second copy behind", t2.length === 1 && idb1.length === 1, "before: " + JSON.stringify(t1) + "; IndexedDB after the rename: " + idb1.map((t) => t.id + ":" + t.title).join(", ") + "; after a reload the list shows " + JSON.stringify(t2), true);
    await ctx.close();
  },
  async S14(browser, base) {
    console.log("\nS14 first-connect banner: nothing is written until the user chooses (audit B1)");
    const PROSE = "# My list\n\nSome prose to keep, forever.\n\n## Open\n- [ ] File task 📅 2030-03-03 ^f00001\n\n## Reference\nImportant notes here.\n";
    const hide = (page) => page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    for (const variant of ["a task is typed", "Ctrl+S is pressed", "the tab is hidden"]) {
      const ctx = await browser.newContext();
      const { page, errors } = await openApp(ctx, base);
      await rw.seed(page, { tasks: [task("br0001", "Browser task", { due: "2030-01-01" })], meta: [{ k: "dirtyFlag", v: true }] });
      await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(PROSE) });
      await reload(page);
      const bn = await waitBanner(page, "conflict", 8000);
      if (!bn.some((b) => b.id === "conflict")) { report("S14 " + variant + ": the first-connect banner appears", false, JSON.stringify(bn), false); await ctx.close(); continue; }
      if (variant === "a task is typed") await addTask(page, "Typed during banner", "2030-05-05");
      else if (variant === "Ctrl+S is pressed") await page.keyboard.press("Control+s");
      else await hide(page);
      await sleep(2500);
      const file = utf8(await rw.readOpfs(page, "todo.md"));
      const ind = await rw.saveState(page);
      report("S14 while the banner is up and " + variant + ", todo.md is untouched", file === PROSE && errors.length === 0, (file === PROSE ? "byte-identical" : "rewritten to: " + JSON.stringify(file.slice(0, 140))) + "; indicator: " + ind, true);
      if (variant === "the tab is hidden") {
        await page.click('#banners .banner[data-bid="conflict"] button:has-text("Use the file")');
        await waitClean(page);
        const titles = await rw.titles(page);
        const file2 = utf8(await rw.readOpfs(page, "todo.md"));
        report("S14 'Use the file' then loads the intact file", titles.includes("File task") && !titles.includes("Browser task") && file2 === PROSE, JSON.stringify(titles), true);
      }
      await ctx.close();
    }
    const ctx = await browser.newContext();
    const { page, errors } = await openApp(ctx, base);
    await rw.seed(page, { tasks: [task("br0001", "Browser task", { due: "2030-01-01" })], meta: [{ k: "dirtyFlag", v: true }] });
    await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(PROSE) });
    await page.addInitScript(`(()=>{const P=FileSystemFileHandle.prototype;const og=P.getFile;P.getFile=async function(...a){if(!window.__readOk)throw new DOMException("simulated transient read failure","NotReadableError");return og.apply(this,a)}})();`);
    await reload(page);
    await sleep(1200);
    const bn2 = await rw.banners(page);
    const chip = await page.evaluate(() => { const c = document.getElementById("fileChip"); return c.hidden ? null : c.querySelector(".lbl").textContent; });
    await page.evaluate(() => { window.__readOk = true; });
    await addTask(page, "Typed after read error", "2030-06-06");
    await sleep(2500);
    const fileA = utf8(await rw.readOpfs(page, "todo.md"));
    const retry = await page.$('#banners .banner button:has-text("Try again")');
    if (retry) await retry.click();
    await sleep(1500);
    const fileB = utf8(await rw.readOpfs(page, "todo.md"));
    const bn3 = await rw.banners(page);
    report("S14 a failed first read is reported as a read failure and nothing is written, before or after Try again", bn2.some((b) => /Couldn't read/.test(b.text || "")) && chip === "file not read" && fileA === PROSE && fileB === PROSE && bn3.some((b) => b.id === "conflict") && errors.length === 0, "banner: " + JSON.stringify(bn2.map((b) => b.text && b.text.slice(0, 70))) + "; chip: " + chip + "; file intact: " + (fileA === PROSE && fileB === PROSE) + "; after retry: " + JSON.stringify(bn3.map((b) => b.id)), true);
    await ctx.close();
  },

  async S15(browser, base) {
    console.log("\nS15 a change committed while an autosave is writing (audit B2)");
    const ctx = await browser.newContext();
    const { page, errors } = await openApp(ctx, base, { init: `(()=>{const P=FileSystemFileHandle.prototype;const orig=P.createWritable;P.createWritable=async function(...a){const w=await orig.apply(this,a);const oc=w.close.bind(w);w.close=async()=>{if(window.__closeDelay)await new Promise(r=>setTimeout(r,window.__closeDelay));return oc()};return w}})();` });
    await rw.seed(page, { meta: [{ k: "settings", v: { schemaVersion: 1, autosaveDebounceMs: 3000 } }] });
    await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(FILE(["- [ ] Base ^b00001"])) });
    await reload(page);
    await waitClean(page);
    await page.evaluate(() => { window.__closeDelay = 2500; });
    await addTask(page, "Task A", "2030-01-01");
    await sleep(3600); // the write is in flight, parked in close()
    const during = await rw.saveState(page);
    await addTask(page, "Task B", "2030-01-02");
    let lied = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const f = utf8(await rw.readOpfs(page, "todo.md"));
      const st = await rw.saveState(page);
      if (f.includes("Task A")) { if (st === "clean" && !f.includes("Task B")) lied = true; break; }
      await sleep(50);
    }
    await waitClean(page, 10000);
    const file2 = utf8(await rw.readOpfs(page, "todo.md"));
    report("S15 the indicator never reads clean while a committed task is missing from the file", during === "saving" && !lied && file2.includes("Task A") && file2.includes("Task B"), "state during the write: " + during + "; claimed clean with B missing: " + lied + "; final file has A: " + file2.includes("Task A") + ", B: " + file2.includes("Task B"), true);
    await page.evaluate(() => { window.__closeDelay = 2500; });
    await addTask(page, "Task C", "2030-01-03");
    await sleep(3600);
    await addTask(page, "Task D", "2030-01-04");
    const t1 = Date.now();
    while (Date.now() - t1 < 6000) { if (utf8(await rw.readOpfs(page, "todo.md")).includes("Task C")) break; await sleep(50); }
    const meta = await rw.idbAll(page, "meta");
    const dirtyFlag = (meta.find((m) => m.k === "dirtyFlag") || {}).v;
    await reload(page); // like closing the tab before the follow-up write: the in-flight change must be replayed at boot
    await waitClean(page, 10000);
    await sleep(500);
    const file3 = utf8(await rw.readOpfs(page, "todo.md"));
    report("S15 a reload right after the write still carries the in-flight change to the file", dirtyFlag === true && file3.includes("Task D") && errors.length === 0, "dirtyFlag after the write: " + dirtyFlag + "; file has D after the reload: " + file3.includes("Task D") + (errors.length ? "; " + errors[0] : ""), true);
    await ctx.close();
  },

  async S16(browser, base) {
    console.log("\nS16 import of an older export into a connected file (audit B3)");
    const ctx = await browser.newContext();
    const { page, errors } = await openApp(ctx, base);
    await rw.connectOpfs(page, { name: "todo.md", bytes: bytesOf(FILE(["- [ ] Report v1 ^r00001"])) });
    await reload(page);
    await waitClean(page);
    await page.click('#listRoot .task[data-id="r00001"] .title');
    await page.fill("#listRoot .title-edit", "Report v2 final");
    await page.press("#listRoot .title-edit", "Enter");
    await waitClean(page);
    await page.click("#settingsBtn");
    await page.waitForSelector('input[type=file][accept=".md,.markdown,.txt"]');
    await page.setInputFiles('input[type=file][accept=".md,.markdown,.txt"]', { name: "old-export.md", mimeType: "text/markdown", buffer: Buffer.from(FILE(["- [ ] Report v1 ^r00001", "- [ ] Restored task ^r00002"])) });
    await sleep(1500);
    await page.keyboard.press("Escape");
    await waitClean(page);
    const titles = await rw.titles(page);
    const file = utf8(await rw.readOpfs(page, "todo.md"));
    const bn = await rw.banners(page);
    report("S16 the current version of a shared task is kept and the new task is added", titles.includes("Report v2 final") && titles.includes("Restored task") && !titles.includes("Report v1") && file.includes("Report v2 final") && file.includes("Restored task") && !file.includes("Report v1") && bn.some((b) => b.id === "import" && /kept/.test(b.text || "")), JSON.stringify(titles) + "; banner: " + JSON.stringify(bn.filter((b) => b.id === "import").map((b) => b.text)), true);
    await blurEntry(page);
    await page.keyboard.press("Control+z");
    // The undo commits to IndexedDB before it re-renders and marks the file dirty, so right after the keypress the
    // indicator still reads clean from before it, and waitClean alone returns at once (CI showed the check running
    // 6-13 ms after the previous one, with the list or the file not yet updated). Wait for the outcome itself.
    let titles2 = [], file2 = "";
    const t2 = Date.now();
    while (Date.now() - t2 < 8000) {
      titles2 = await rw.titles(page); file2 = utf8(await rw.readOpfs(page, "todo.md"));
      if (!titles2.includes("Restored task") && !file2.includes("Restored task")) break;
      await sleep(100);
    }
    await waitClean(page);
    titles2 = await rw.titles(page); file2 = utf8(await rw.readOpfs(page, "todo.md"));
    report("S16 Ctrl+Z undoes the import", !titles2.includes("Restored task") && titles2.includes("Report v2 final") && !file2.includes("Restored task") && errors.length === 0, JSON.stringify(titles2) + (errors.length ? "; " + errors[0] : ""), true);
    await ctx.close();
  },

  async S17(browser, base) {
    console.log("\nS17 Firefox/Safari mode: export after a reload keeps the imported layout (audit B4)");
    const ctx = await browser.newContext();
    const init = `delete window.showOpenFilePicker;delete window.showDirectoryPicker;(()=>{const o=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__lastBlob=b;return o(b)};HTMLAnchorElement.prototype.click=function(){}})();`;
    const { page, errors } = await openApp(ctx, base, { init });
    const PROSE = "# My list\n\nSome prose to keep, forever.\n\n## Open\n- [ ] File task 📅 2030-03-03 ^f00001\n\n## Reference\nImportant notes here.\n";
    await page.click("#settingsBtn");
    await page.waitForSelector('input[type=file][accept=".md,.markdown,.txt"]');
    await page.setInputFiles('input[type=file][accept=".md,.markdown,.txt"]', { name: "todo.md", mimeType: "text/markdown", buffer: Buffer.from(PROSE) });
    await sleep(1200);
    await page.keyboard.press("Escape");
    const exportText = () => page.evaluate(async () => {
      document.getElementById("settingsBtn").click();
      await new Promise((r) => setTimeout(r, 300));
      Array.from(document.querySelectorAll("button")).find((x) => x.textContent === "Export .md").click();
      await new Promise((r) => setTimeout(r, 300));
      const t = window.__lastBlob ? await window.__lastBlob.text() : null;
      const x = document.querySelector(".panel .px"); if (x) x.click();
      return t;
    });
    const exp1 = await exportText();
    await addTask(page, "Added in the browser", "2030-02-02");
    await sleep(1500);
    await reload(page);
    await sleep(500);
    const exp2 = await exportText();
    report("S17 export after a reload still carries the imported headings and prose", !!exp1 && exp1.includes("Important notes here.") && !!exp2 && exp2.includes("Some prose to keep, forever.") && exp2.includes("Important notes here.") && exp2.includes("Added in the browser") && exp2.includes("File task") && errors.length === 0, exp2 ? exp2.split("\n").slice(0, 7).join(" ⏎ ") : "no export" + (errors.length ? "; " + errors[0] : ""), true);
    await ctx.close();
  },
};

(async () => {
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(HTML); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port + "/";
  const browser = await pw.chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  results.meta.chromium = browser.version();
  console.log("robust-browser · chromium " + browser.version() + " · " + base);
  for (const [name, fn] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try { await fn(browser, base); }
    catch (e) { report(name + " harness", false, String((e && e.message) || e).split("\n")[0].slice(0, 300), false); }
  }
  await browser.close();
  server.close();
  const ok = results.checks.filter((c) => c.ok).length;
  console.log("\n" + ok + " / " + results.checks.length + " checks behaved · " + findings + " finding(s)");
  if (FAIL_ON_NEW) {
    const bad = results.checks.filter((c) => !c.ok && !KNOWN_OPEN.test(c.name));
    if (bad.length) { console.error("\nnew findings or harness errors:\n  " + bad.map((c) => c.name).join("\n  ")); process.exitCode = 1; }
    else console.log("no findings beyond the documented open Lows " + KNOWN_OPEN);
  }
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log("results written to " + OUT); }
})().catch((e) => { console.error(e); process.exit(1); });
