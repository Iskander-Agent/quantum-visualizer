#!/usr/bin/env node
import fs from "fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const errors = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

assert(
  !html.includes("${data.length} developers have voiced positions"),
  "dashboard must not read data.length; the dataset is an object with metadata/developers",
);

assert(
  html.includes("${voiced.voices_count} of ${total} developers have voiced positions"),
  "voiced-position copy should use metadata.total_assessed",
);

assert(
  html.includes("const rankMax = Math.max(...ranked.map(d => d.rank), 1);"),
  "bubble chart should compute its influence scale from ranked entries",
);

assert(
  html.includes("Math.max(rankMax - 1, 1)"),
  "bubble chart should scale x positions against the max ranked position, not total assessed entries",
);

if (errors.length) {
  console.error(`check-dashboard-source failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("check-dashboard-source passed");
