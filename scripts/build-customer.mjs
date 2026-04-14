#!/usr/bin/env node
// Build public/customer.json — Customer World Model snapshot.
// Pulls from aibtc.news signals API (quantum-* beats) and GitHub #33 comments (via gh).
// Fields we cannot verify are explicitly "unknown" — never fabricated.
import fs from "fs";
import { execSync } from "child_process";

const OUT = new URL("../public/customer.json", import.meta.url);
const today = new Date().toISOString().slice(0, 10);
const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function gh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

const signalsRes = await fetchJSON("https://aibtc.news/api/signals?limit=500");
const allSignals = signalsRes.signals || signalsRes;
const quantum = allSignals.filter((s) => (s.beatSlug || "").includes("quantum"));

const by_agent = {};
for (const s of quantum) by_agent[s.displayName] = (by_agent[s.displayName] || 0) + 1;

const last_7d = quantum.filter((s) => (s.utcDate || s.timestamp || "").slice(0, 10) >= sevenDaysAgo).length;

const comments = JSON.parse(
  gh("gh api repos/1btc-news/news-client/issues/33/comments --paginate")
);
const contributors = [...new Set(comments.map((c) => c.user.login))];
const iskander_comments = comments.filter((c) => c.user.login === "Iskander-Agent").length;

const prsRaw = JSON.parse(
  gh("gh pr list --repo Iskander-Agent/quantum-visualizer --state all --limit 100 --json number,state,author,title,mergedAt")
);
const merged = prsRaw.filter((p) => p.state === "MERGED");
const pr_contributors = [...new Set(merged.map((p) => p.author.login))];

const customer = {
  schema_version: 1,
  as_of: today,
  quantum_beats: {
    total: quantum.length,
    by_agent,
    last_7d,
    source: "https://aibtc.news/api/signals",
  },
  sats_flow: {
    bounty_30_paid: {
      amount_sats: 100000,
      txid: "d4648ce29197b0df2bf09658cc93e835f5de69fe2b11febaddf0087f3a568f9b",
      note: "Original research bounty (Issue #30), on-chain proof",
    },
    bounty_33_pool_sats: 250000,
    bounty_33_paid_confirmed: "unknown — awaiting on-chain payout ledger in #33",
    revenue_x402_sats: 0,
    inscription_sales_sats: 0,
  },
  narrative_traction: {
    issue_33_total_comments: comments.length,
    issue_33_unique_participants: contributors.length,
    issue_33_iskander_comments: iskander_comments,
    quantum_visualizer_merged_prs: merged.length,
    quantum_visualizer_pr_contributors: pr_contributors.length,
    pr_contributor_handles: pr_contributors,
    dashboard_visits: "unknown — no analytics instrumented",
    x_engagement: "unknown — x-posting paused (credits depleted)",
  },
  freshness: {
    signals_fetched_at: new Date().toISOString(),
    github_fetched_at: new Date().toISOString(),
    next_refresh_target: "weekly synthesis (Sundays)",
  },
  notes: [
    "Silence is not a data point. Unknown fields stay unknown until verified.",
    "Regenerate with: node scripts/build-customer.mjs",
  ],
};

fs.writeFileSync(OUT, JSON.stringify(customer, null, 2) + "\n");
console.log(`wrote customer.json: ${quantum.length} beats, ${comments.length} comments, ${merged.length} merged PRs`);
