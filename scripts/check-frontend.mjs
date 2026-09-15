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
  "research-gap-panel",
  "research-gap-count",
  "research-gap-body",
  "research-gap-copy-status",
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
assert(html.includes("function collectResearchGaps"), "missing collectResearchGaps()");
assert(html.includes("function buildResearchBrief"), "missing buildResearchBrief()");
assert(html.includes("function renderResearchGapQueue"), "missing renderResearchGapQueue()");
assert(
  html.includes("Number(d.quantum_urgency_score)===1"),
  "research gap queue must include only developers with no known quantum position",
);
assert(
  html.includes("(influenceScore*0.7)+(ageScore*0.3)"),
  "research gap priority must blend influence and data age",
);
assert(html.includes("data-research-open"), "research gaps must expose an Open action");
assert(html.includes("data-research-copy"), "research gaps must expose a Copy brief action");
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
