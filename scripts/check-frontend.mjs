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
  "affiliation-panel",
  "affiliation-summary",
  "affiliation-count",
  "affiliation-body",
  "freshness-panel",
  "freshness-body",
  "freshness-updates",
  "freshness-stale-list",
  "beats-panel",
  "beats-kpis",
  "beats-week",
  "beats-body",
  "beats-asof",
  "beats-source",
  "payout-panel",
  "payout-kpis",
  "payout-ledger-body",
  "pr-queue-panel",
  "pr-queue-kpis",
  "pr-queue-body",
  "compare-panel",
  "compare-count",
  "compare-add-select",
  "compare-slots",
  "compare-table-head",
  "compare-table-body",
  "mobile-scorecards",
]) {
  assert(html.includes(`id="${id}"`), `missing #${id}`);
}

assert(
  html.includes("function renderAffiliationReadiness"),
  "missing renderAffiliationReadiness()",
);
assert(html.includes("function renderFreshnessAudit"), "missing renderFreshnessAudit()");
assert(html.includes("function renderQuantumBeats"), "missing renderQuantumBeats()");
assert(html.includes("renderQuantumBeats(customer);"), "renderCustomerWorld must wire in renderQuantumBeats");
assert(html.includes("quantum_beats"), "quantum beats panel must surface the quantum_beats customer world model");
assert(html.includes("last_7d"), "quantum beats panel must surface rolling 7-day activity");
assert(html.includes("by_agent"), "quantum beats panel must surface the per-agent breakdown");
assert(
  html.includes("Quantum beats data is not available in /customer.json."),
  "quantum beats panel must degrade gracefully when the customer model is missing",
);
assert(html.includes("Rolling 7-day cadence"), "quantum beats panel must surface the rolling 7-day cadence");
assert(html.includes("function renderPayoutLedger"), "missing renderPayoutLedger()");
assert(html.includes("function renderPrWorkQueue"), "missing renderPrWorkQueue()");
assert(html.includes("function renderCompareView"), "missing renderCompareView()");
assert(html.includes("function toggleCompareDev"), "missing toggleCompareDev()");
assert(html.includes("params.append('compare',name)"), "compare selections must be URL-shareable");
assert(html.includes("function renderMobileScorecards"), "missing renderMobileScorecards()");
assert(html.includes(".table-wrap{display:none}"), "mobile breakpoint should replace the wide scorecard table");
assert(html.includes("openDrawer(dev);"), "mobile scorecards should open the existing detail drawer");
assert(html.includes("fetch('/customer.json')"), "missing customer world model fetch");
assert(!html.includes("${data.length}"), "readiness panel must use metadata total, not object.length");

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
