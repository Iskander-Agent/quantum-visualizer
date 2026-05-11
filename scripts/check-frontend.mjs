#!/usr/bin/env node
import fs from "fs";
import vm from "vm";

const FILE = new URL("../public/index.html", import.meta.url);
const html = fs.readFileSync(FILE, "utf8");
const errors = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

for (const id of [
  "freshness-panel",
  "freshness-body",
  "freshness-updates",
  "freshness-stale-list",
]) {
  assert(html.includes(`id="${id}"`), `missing #${id}`);
}

assert(html.includes("function renderFreshnessAudit"), "missing renderFreshnessAudit()");

const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
assert(scriptMatch, "missing inline script block");

if (scriptMatch) {
  try {
    new vm.Script(scriptMatch[1], { filename: "public/index.html <script>" });
  } catch (error) {
    errors.push(`inline script syntax error: ${error.message}`);
  }
}

if (errors.length) {
  console.error(`check-frontend failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("check-frontend passed");
