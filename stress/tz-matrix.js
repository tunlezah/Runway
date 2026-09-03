#!/usr/bin/env node
/* tz-matrix.js — does Runway's date engine survive the world's time zones?

   Spawns one child per zone (TZ=<zone>) and, in each, walks every calendar day from
   2024-01-01 to 2027-12-31 checking the invariants the app relies on:

     isoOf(parseISO(iso)) === iso            local-midnight construction never shifts a day
     midnight(parseISO(iso)) stays the day   setHours(0,0,0,0) on DST-at-midnight days
     daysBetween(day, day+1) === 1           day arithmetic across DST, leap days, year ends
     DateParse "+1" / "tom" === day+1        the date language agrees with the calendar
     DateParse weekday names land in 1..7    and on the right weekday
     addWorkDays ∘ workDaysBetween identity  work-day engine
     calWeeks rows are consecutive days      calendar grid never repeats or skips a day
     recFor(day+1, day).cal === 1            urgency records
     weekStartISO is a Monday ≤ day          stats bucketing
     next-midnight timer target > now        the midnight re-render alarm

   It also runs the embedded suite (node test.js) once per zone, and once per zone with
   the clock frozen at a few awkward instants (a DST gap, New Year's Eve, a leap day).

   Usage: node stress/tz-matrix.js [--quick]
*/
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const QUICK = process.argv.includes("--quick");
const ROOT = path.join(__dirname, "..");

const ZONES = QUICK
  ? ["UTC", "America/Santiago", "Pacific/Apia", "Asia/Kathmandu", "Europe/Dublin"]
  : [
      "UTC", "Etc/GMT+12", "Etc/GMT-14",
      "America/New_York", "America/Los_Angeles", "America/St_Johns", "America/Sao_Paulo",
      "America/Santiago", "America/Asuncion", "America/Havana", "America/Nuuk", "America/Scoresbysund",
      "Europe/London", "Europe/Dublin", "Europe/Berlin", "Europe/Moscow",
      "Africa/Casablanca", "Africa/Cairo", "Asia/Gaza", "Asia/Amman", "Asia/Tehran",
      "Asia/Kolkata", "Asia/Kathmandu", "Asia/Tokyo",
      "Australia/Lord_Howe", "Australia/Sydney", "Pacific/Chatham", "Pacific/Apia", "Pacific/Kiritimati", "Pacific/Norfolk", "Antarctica/Troll",
    ];
const FROZEN = [
  ["2026-03-08T02:30:00", "US DST gap (non-existent local time in US zones)"],
  ["2026-12-31T23:59:59", "New Year's Eve, one second before midnight"],
  ["2028-02-29T12:00:00", "leap day"],
  ["2026-10-25T01:30:00", "EU fall-back hour (ambiguous local time)"],
];

if (process.argv.includes("--child")) { child(); process.exit(0); }

function loadApp() {
  const html = fs.readFileSync(path.join(ROOT, "runway.html"), "utf8");
  const m = /\/\*JS-START\*\/([\s\S]*?)\/\*JS-END\*\//.exec(html);
  const mod = { exports: {} };
  new Function("module", "exports", m[1])(mod, mod.exports);
  return mod.exports;
}

function child() {
  const app = loadApp();
  const { Util, DateParse, Days, Views, Stats, SETTINGS } = app;
  const MF = Days.weekArr([1, 2, 3, 4, 5]);
  const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const fails = {};
  const fail = (k, detail) => { fails[k] = fails[k] || { n: 0, first: detail }; fails[k].n++; };
  const start = new Date(2024, 0, 1), end = new Date(2027, 11, 31);
  let days = 0;
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    days++;
    const iso = Util.isoOf(d);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const nextIso = Util.isoOf(next);
    if (Util.isoOf(Util.parseISO(iso)) !== iso) fail("parseISO/isoOf", iso + " → " + Util.isoOf(Util.parseISO(iso)));
    if (Util.isoOf(Util.midnight(Util.parseISO(iso))) !== iso) fail("midnight", iso + " → " + Util.isoOf(Util.midnight(Util.parseISO(iso))));
    if (Util.daysBetween(Util.parseISO(iso), Util.parseISO(nextIso)) !== 1) fail("daysBetween", iso + "→" + nextIso + " = " + Util.daysBetween(Util.parseISO(iso), Util.parseISO(nextIso)));
    const p1 = DateParse.parse("+1", { today: Util.parseISO(iso) });
    if (p1.iso !== nextIso) fail("DateParse +1", iso + " → " + p1.iso + " (want " + nextIso + ")");
    const tom = DateParse.parse("tom", { today: Util.parseISO(iso) });
    if (tom.iso !== nextIso) fail("DateParse tom", iso + " → " + tom.iso);
    for (let w = 0; w < 7; w++) {
      const r = DateParse.parse(WD[w], { today: Util.parseISO(iso) });
      const delta = r.kind === "date" ? Util.daysBetween(Util.parseISO(iso), Util.parseISO(r.iso)) : NaN;
      if (!(delta >= 1 && delta <= 7) || Util.parseISO(r.iso).getDay() !== w) fail("DateParse weekday", iso + " " + WD[w] + " → " + (r.iso || r.reason));
    }
    const wk = Util.addWorkDays(Util.parseISO(iso), 3, MF);
    if (Util.workDaysBetween(Util.parseISO(iso), wk, MF) !== 3) fail("addWorkDays/workDaysBetween", iso + " +3b → " + Util.isoOf(wk));
    const rec = Days.recFor(nextIso, Util.parseISO(iso));
    if (rec.cal !== 1 || rec.eff !== 1) fail("recFor", iso + "→" + nextIso + " " + JSON.stringify(rec));
    const ws = Stats.weekStartISO(Util.parseISO(iso));
    if (Util.parseISO(ws).getDay() !== 1 || ws > iso || Util.daysBetween(Util.parseISO(ws), Util.parseISO(iso)) > 6) fail("weekStartISO", iso + " → " + ws);
    if (d.getDate() === 1) {
      const weeks = Views.calWeeks(d.getFullYear(), d.getMonth() + 1);
      const flat = weeks.flat();
      for (let i = 1; i < flat.length; i++) if (Util.daysBetween(Util.parseISO(flat[i - 1]), Util.parseISO(flat[i])) !== 1) fail("calWeeks", flat[i - 1] + "→" + flat[i]);
      if (!flat.includes(iso) || !flat.includes(Util.isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)))) fail("calWeeks range", iso);
    }
    // the midnight alarm as App.armMidnight computes it, from three instants in the day
    for (const h of [0, 12, 23]) {
      const now = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 30);
      if (now.getDate() !== d.getDate()) continue; // that wall-clock time does not exist on this day (DST gap); the app only ever sees real instants
      const nextMid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      const ms = nextMid - now;
      if (!(ms > 0 && ms <= 26 * 3600e3)) fail("armMidnight", iso + " " + h + ":30 → " + ms + "ms");
      if (Util.isoOf(nextMid) !== nextIso) fail("armMidnight target day", iso + " → " + Util.isoOf(nextMid));
    }
  }
  const eom = DateParse.parse("eom", { today: new Date(2026, 1, 10) });
  if (eom.iso !== "2026-02-28") fail("eom", eom.iso);
  const plusM = DateParse.parse("+1m", { today: new Date(2026, 0, 31) });
  if (plusM.iso !== "2026-02-28") fail("+1m clamp", plusM.iso);
  console.log(JSON.stringify({ tz: process.env.TZ, days, offsetNow: new Date().getTimezoneOffset(), fails }));
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: Object.assign({}, process.env, env), encoding: "utf8", timeout: 300000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const summary = [];
console.log("tz-matrix · node " + process.version + " · " + ZONES.length + " zones · " + (QUICK ? "quick" : "full"));
console.log("\nzone                      offset  days   invariants                          test.js");
let anyFail = false;
for (const tz of ZONES) {
  const inv = run(process.execPath, [__filename, "--child"], { TZ: tz });
  let parsed = null;
  try { parsed = JSON.parse(inv.out.trim().split("\n").pop()); } catch (e) { /* fallthrough */ }
  const t = run(process.execPath, ["test.js"], { TZ: tz });
  const tline = (t.out.match(/\d+ \/ \d+ passed/) || ["?"])[0] + (t.status ? " FAIL" : "");
  const failKeys = parsed ? Object.entries(parsed.fails) : [["child crashed", { n: 1, first: inv.out.slice(0, 200) }]];
  const invTxt = failKeys.length ? failKeys.map(([k, v]) => k + "×" + v.n).join(", ") : "all held";
  if (failKeys.length || t.status) anyFail = true;
  console.log(tz.padEnd(26) + String(parsed ? -parsed.offsetNow / 60 : "?").padEnd(8) + String(parsed ? parsed.days : "?").padEnd(7) + invTxt.padEnd(36) + tline);
  for (const [k, v] of failKeys) console.log("    ↳ " + k + ": " + v.first);
  summary.push({ tz, days: parsed && parsed.days, fails: parsed && parsed.fails, testJs: tline });
}

console.log("\nembedded suite with the clock frozen (Date patched before the app loads):");
const PRELOAD = (iso) => `const R=Date;const f=new R(${JSON.stringify(iso)});global.Date=class extends R{constructor(...a){super(...(a.length?a:[f.getTime()]))}static now(){return f.getTime()}};require(${JSON.stringify(path.join(ROOT, "test.js"))});`;
for (const tz of QUICK ? ["America/New_York", "Europe/Berlin"] : ["America/New_York", "Europe/Berlin", "America/Santiago", "Pacific/Kiritimati", "Etc/GMT+12"]) {
  for (const [iso, why] of FROZEN) {
    const r = run(process.execPath, ["-e", PRELOAD(iso)], { TZ: tz });
    const line = (r.out.match(/\d+ \/ \d+ passed/) || [r.out.trim().split("\n").pop() || "?"])[0];
    if (r.status) anyFail = true;
    console.log("  " + tz.padEnd(22) + iso + "  " + line.padEnd(20) + (r.status ? "FAIL — " + r.out.split("\n").filter((l) => l.startsWith("✗")).slice(0, 3).join(" | ") : "") + "   (" + why + ")");
    summary.push({ tz, frozen: iso, testJs: line, failed: !!r.status });
  }
}
console.log("\n" + (anyFail ? "some checks FAILED" : "every invariant held in every zone"));
process.exitCode = anyFail ? 1 : 0;
