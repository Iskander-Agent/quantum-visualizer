#!/usr/bin/env node
// Idempotent: ensures every developer has last_verified, keeps metadata.last_updated in sync.
// Run: node scripts/stamp-freshness.mjs [--dev "Name" --date YYYY-MM-DD]
import fs from "fs";

const FILE = new URL("../public/data.json", import.meta.url);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const today = new Date().toISOString().slice(0, 10);
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const defaultDate = data.metadata.date || today;

let stamped = 0;
for (const dev of data.developers) {
  if (args.dev && dev.name === args.dev) {
    dev.last_verified = args.date || today;
    stamped++;
  } else if (!dev.last_verified) {
    dev.last_verified = defaultDate;
    stamped++;
  }
}

data.metadata.last_updated = today;
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
console.log(`stamped ${stamped} developer(s); metadata.last_updated=${today}`);
