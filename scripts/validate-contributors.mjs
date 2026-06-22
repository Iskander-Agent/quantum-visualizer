#!/usr/bin/env node
import fs from "fs";

const ROOT_FILE = new URL("../contributors.json", import.meta.url);
const PUBLIC_FILE = new URL("../public/contributors.json", import.meta.url);
const root = JSON.parse(fs.readFileSync(ROOT_FILE, "utf8"));
const pub = JSON.parse(fs.readFileSync(PUBLIC_FILE, "utf8"));
const errors = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isBtcAddress(value) {
  return value === null || (typeof value === "string" && /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,90}$/i.test(value));
}

function isStxAddress(value) {
  return value === null || (typeof value === "string" && /^S[PT][0-9A-HJKMNP-TV-Z]{38,41}$/.test(value));
}

assert(JSON.stringify(root) === JSON.stringify(pub), "contributors.json and public/contributors.json must stay in sync");
assert(root.schema === "quantum.revenue.contributors.v1", "unexpected schema");
assert(isDate(root.updated_at), "updated_at must be YYYY-MM-DD");
assert(root.policy?.asset === "sBTC", "policy.asset must be sBTC");
assert(root.policy?.network === "stacks:1", "policy.network must be stacks:1");
assert(Number.isInteger(root.policy?.price_sats) && root.policy.price_sats > 0, "policy.price_sats must be positive integer");

const split = root.policy?.split_bps || {};
const splitTotal = (split.contributor || 0) + (split.player_coach || 0) + (split.dri || 0);
assert(splitTotal === 10000, `split_bps must total 10000, got ${splitTotal}`);

const entries = Array.isArray(root.endpoint_attribution) ? root.endpoint_attribution : [];
assert(entries.length > 0, "endpoint_attribution must not be empty");

const required = new Set(["top-urgent", "index-breakdown", "dev/*", "since/*", "silent-developers"]);
const seen = new Set();
for (const [index, entry] of entries.entries()) {
  const label = entry.slug || `endpoint_attribution[${index}]`;
  assert(typeof entry.slug === "string" && entry.slug.trim(), `${label}: slug required`);
  assert(!seen.has(entry.slug), `${label}: duplicate slug`);
  seen.add(entry.slug);
  required.delete(entry.slug);
  assert(typeof entry.path === "string" && entry.path.startsWith("/api/world/premium/"), `${label}: path must be a premium API path`);
  assert(typeof entry.contributor === "string" && entry.contributor.trim(), `${label}: contributor required`);
  assert(isBtcAddress(entry.btc_address), `${label}: invalid btc_address`);
  assert(isStxAddress(entry.stx_address), `${label}: invalid stx_address`);
  assert(Number.isInteger(entry.revenue_share_bps), `${label}: revenue_share_bps must be integer`);
  assert(entry.revenue_share_bps >= 0 && entry.revenue_share_bps <= 10000, `${label}: revenue_share_bps out of range`);
  assert(typeof entry.status === "string" && entry.status.trim(), `${label}: status required`);
}

assert(required.size === 0, `missing attribution entries: ${[...required].join(", ")}`);

if (errors.length) {
  console.error(`validate-contributors failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`validate-contributors passed: ${entries.length} endpoint attribution entries`);
