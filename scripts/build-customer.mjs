#!/usr/bin/env node
// Build public/customer.json — Customer World Model snapshot.
// Pulls from aibtc.news signals API (quantum-* beats), GitHub #33 comments via gh,
// and the REVENUE_LOG KV namespace on Cloudflare for x402 paid-call events.
// Fields we cannot verify are explicitly "unknown" — never fabricated.
import fs from "fs";
import { execSync } from "child_process";

const OUT = new URL("../public/customer.json", import.meta.url);
const today = new Date().toISOString().slice(0, 10);
const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

const CF_ACCOUNT_ID = "6401c671eef455c629ee2f10cd6cdc61";
const KV_NAMESPACE_ID = "570c38b0f3324aab8afb4b8be15c3479";

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function gh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function readEnv(key) {
  const envFile = `${process.env.HOME}/.openclaw/.env`;
  const line = fs.readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not in ${envFile}`);
  return line.slice(key.length + 1);
}

async function fetchRevenueLedger() {
  const token = readEnv("CLOUDFLARE_API_TOKEN");
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/ledger:events`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`KV fetch failed: ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return []; }
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

const ledger = await fetchRevenueLedger();
const revenueSats = ledger.reduce((sum, e) => sum + (e.sats || 0), 0);
const eventsLast7d = ledger.filter((e) => (e.ts || "").slice(0, 10) >= sevenDaysAgo);

const customer = {
  schema_version: 2,
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
    revenue_x402_sats: revenueSats,
    revenue_x402_events: ledger.length,
    revenue_x402_last_7d_events: eventsLast7d.length,
    revenue_x402_recent: ledger.slice(-5),
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
    revenue_kv_fetched_at: new Date().toISOString(),
    next_refresh_target: "weekly synthesis (Sundays)",
  },
  notes: [
    "Silence is not a data point. Unknown fields stay unknown until verified.",
    "Regenerate with: node scripts/build-customer.mjs",
  ],
};

fs.writeFileSync(OUT, JSON.stringify(customer, null, 2) + "\n");
console.log(`wrote customer.json: ${quantum.length} beats, ${comments.length} comments, ${merged.length} merged PRs, ${ledger.length} x402 events (${revenueSats} sats)`);
