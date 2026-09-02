#!/usr/bin/env node
/* Runs the test suite embedded in runway.html — the same tests the app runs
   in the browser when opened with #test. No dependencies; just `node test.js`. */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "runway.html"), "utf8");
const m = /\/\*JS-START\*\/([\s\S]*?)\/\*JS-END\*\//.exec(html);
if (!m) {
  console.error("could not find /*JS-START*/ … /*JS-END*/ markers in runway.html");
  process.exit(2);
}

const mod = { exports: {} };
new Function("module", "exports", m[1])(mod, mod.exports);

const results = mod.exports.Tests.run();
const fails = results.filter(r => !r.pass);
for (const f of fails) console.error("✗ " + f.name + (f.detail ? " — " + f.detail : ""));
console.log(results.length - fails.length + " / " + results.length + " passed");
process.exit(fails.length ? 1 : 0);
