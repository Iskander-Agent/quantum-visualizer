#!/usr/bin/env node
// Validate the Quantum Visualizer company world model before data PRs merge.
// Checks metadata/developer consistency, freshness stamps, source URLs, and score distribution.
import fs from "fs";

const FILE = new URL("../public/data.json", import.meta.url);
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const errors = [];
const warnings = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function warn(condition, message) {
  if (!condition) warnings.push(message);
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHttpUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

assert(data && typeof data === "object", "data.json must parse to an object");
assert(data.metadata && typeof data.metadata === "object", "metadata object is required");
assert(Array.isArray(data.developers), "developers must be an array");

const developers = Array.isArray(data.developers) ? data.developers : [];
const metadata = data.metadata || {};
const names = new Set();
const distribution = {
  "5_urgent": 0,
  "4_proactive": 0,
  "3_cautious": 0,
  "2_dismissive": 0,
  "1_no_known_view": 0,
};
let notableAdditions = 0;
let ranked = 0;

for (const [index, dev] of developers.entries()) {
  const label = dev?.name || `developer[${index}]`;
  assert(dev && typeof dev === "object", `developer[${index}] must be an object`);
  assert(typeof dev.name === "string" && dev.name.trim(), `${label}: name is required`);
  assert(!names.has(dev.name), `${label}: duplicate developer name`);
  if (dev.name) names.add(dev.name);

  assert(Number.isInteger(dev.quantum_urgency_score), `${label}: quantum_urgency_score must be an integer`);
  assert(dev.quantum_urgency_score >= 1 && dev.quantum_urgency_score <= 5, `${label}: quantum_urgency_score must be 1..5`);
  if (dev.quantum_urgency_score === 5) distribution["5_urgent"]++;
  if (dev.quantum_urgency_score === 4) distribution["4_proactive"]++;
  if (dev.quantum_urgency_score === 3) distribution["3_cautious"]++;
  if (dev.quantum_urgency_score === 2) distribution["2_dismissive"]++;
  if (dev.quantum_urgency_score === 1) distribution["1_no_known_view"]++;

  warn(Number.isInteger(dev.pq_work_volume), `${label}: pq_work_volume should be an integer`);
  assert(isDate(dev.last_verified), `${label}: last_verified must be YYYY-MM-DD`);
  assert(Array.isArray(dev.sources), `${label}: sources must be an array`);
  if (Array.isArray(dev.sources)) {
    if (dev.quantum_urgency_score >= 2) {
      assert(dev.sources.length > 0, `${label}: score ${dev.quantum_urgency_score} entries must cite at least one source`);
    } else {
      warn(dev.sources.length > 0, `${label}: score-1 null-result entry has no source; acceptable but harder to audit`);
    }
    for (const source of dev.sources) assert(isHttpUrl(source), `${label}: invalid source URL ${JSON.stringify(source)}`);
  }
  if (dev.key_source !== undefined && dev.key_source !== null) {
    assert(isHttpUrl(dev.key_source), `${label}: key_source must be an http(s) URL`);
  }
  warn(typeof dev.summary === "string" && dev.summary.trim().length >= 20, `${label}: summary is short or missing`);
  if (dev.notable) notableAdditions++;
  if (Number.isInteger(dev.rank) && dev.rank >= 1 && dev.rank <= 50) ranked++;
}

assert(metadata.total_assessed === developers.length, `metadata.total_assessed=${metadata.total_assessed} but developers.length=${developers.length}`);
assert(metadata.ranked === ranked, `metadata.ranked=${metadata.ranked} but counted ranked=${ranked}`);
assert(metadata.notable_additions === notableAdditions, `metadata.notable_additions=${metadata.notable_additions} but counted notable=${notableAdditions}`);

for (const [key, count] of Object.entries(distribution)) {
  assert(metadata.score_distribution?.[key] === count, `metadata.score_distribution.${key}=${metadata.score_distribution?.[key]} but counted ${count}`);
}

assert(isDate(metadata.date), "metadata.date must be YYYY-MM-DD");
warn(isDate(metadata.last_updated), "metadata.last_updated should be YYYY-MM-DD");
warn(Array.isArray(metadata.update_history), "metadata.update_history should be an array");

for (const [index, entry] of (metadata.update_history || []).entries()) {
  assert(isDate(entry.date), `update_history[${index}]: date must be YYYY-MM-DD`);
  assert(typeof entry.developer === "string" && entry.developer.trim(), `update_history[${index}]: developer is required`);
  assert(typeof entry.change === "string" && entry.change.trim(), `update_history[${index}]: change is required`);
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (errors.length) {
  console.error(`validate-data failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`validate-data passed: ${developers.length} developers, ranked=${ranked}, notable=${notableAdditions}`);
