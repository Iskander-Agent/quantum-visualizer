#!/usr/bin/env node
// Append-only updates to metadata.update_history.
// Run: node scripts/append-history.mjs --developer "Name" --change "1->3" --pr "#15" --contributor "@handle" [--date YYYY-MM-DD]
import fs from "fs";

const FILE = new URL("../public/data.json", import.meta.url);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

if (!args.developer || !args.change) {
  console.error("required: --developer <name> --change <desc> [--pr] [--contributor] [--date]");
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
data.metadata.update_history = data.metadata.update_history || [];

const entry = {
  date: args.date || today,
  developer: args.developer,
  change: args.change,
  pr: args.pr || null,
  contributor: args.contributor || null,
};
data.metadata.update_history.push(entry);
data.metadata.last_updated = today;

// stamp the dev too
const dev = data.developers.find((d) => d.name === args.developer);
if (dev) dev.last_verified = entry.date;

fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
console.log("appended:", JSON.stringify(entry));
