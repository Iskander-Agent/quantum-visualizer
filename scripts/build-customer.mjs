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
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    } catch (error) {
      lastError = error;
      if (attempt < 3) execSync(`sleep ${attempt}`);
    }
  }
  throw lastError;
}

function readExistingCustomer() {
  try {
    return JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
}

function readBaseCustomer() {
  try {
    return JSON.parse(gh("git show origin/main:public/customer.json"));
  } catch {
    return null;
  }
}

function sumObjectValues(value) {
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function readEnv(key) {
  if (process.env[key]) return process.env[key];
  const homes = [process.env.HOME, process.env.USERPROFILE].filter(Boolean);
  for (const home of homes) {
    const envFile = `${home}/.openclaw/.env`;
    if (!fs.existsSync(envFile)) continue;
    const line = fs.readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).trim();
  }
  throw new Error(`${key} not found in environment or .openclaw/.env`);
}

async function fetchRevenueLedger(existing) {
  try {
    const token = readEnv("CLOUDFLARE_API_TOKEN");
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/ledger:events`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) return { events: [], totalSats: 0, totalEvents: 0, last7dEvents: 0, fetchedAt: new Date().toISOString(), note: null };
    if (!r.ok) throw new Error(`KV fetch failed: ${r.status}`);
    const text = await r.text();
    const events = JSON.parse(text || "[]");
    const last7dEvents = events.filter((e) => (e.ts || "").slice(0, 10) >= sevenDaysAgo).length;
    return {
      events,
      totalSats: events.reduce((sum, e) => sum + (e.sats || 0), 0),
      totalEvents: events.length,
      last7dEvents,
      fetchedAt: new Date().toISOString(),
      note: null,
    };
  } catch (error) {
    const sats = existing?.sats_flow?.revenue_x402_sats ?? "unknown";
    const events = existing?.sats_flow?.revenue_x402_events ?? "unknown";
    const last7dEvents = existing?.sats_flow?.revenue_x402_last_7d_events;
    return {
      events: existing?.sats_flow?.revenue_x402_recent || [],
      totalSats: sats,
      totalEvents: events,
      last7dEvents: typeof last7dEvents === "number" ? last7dEvents : "unknown",
      fetchedAt: `not refreshed - ${error.message}`,
      note: "Revenue KV unavailable in this environment; preserved the previous x402 counters.",
    };
  }
}

function parseSats(body) {
  const match = String(body || "").match(/([0-9][0-9,]*)\s*(?:sat|sats|satoshis)\b/i);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function parseBtcAddress(body) {
  const match = String(body || "").match(/\bbc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,90}\b/i);
  return match ? match[0] : null;
}

function parseTxid(body) {
  const match = String(body || "").match(/\b[0-9a-f]{64}\b/i);
  return match ? match[0] : null;
}

function parsePrNumber(body) {
  const text = String(body || "");
  const urlMatch = text.match(/quantum-visualizer\/pull\/(\d+)/i);
  if (urlMatch) return Number(urlMatch[1]);
  const prMatch = text.match(/\bPR\s*#(\d+)\b/i);
  return prMatch ? Number(prMatch[1]) : null;
}

function inferPayoutState(body) {
  const text = String(body || "").toLowerCase();
  const negative = /not paid|no paid|no received transaction|pending|awaiting|zero transactions/.test(text);
  if (!negative && /paid on-chain|payment sent|payout sent|txid|transaction id|on-chain proof/.test(text)) return "paid";
  if (/(payment|payout) request ack/.test(text)) return "acked";
  if (/payout request|payment request|requesting\s+\*{0,2}[0-9,]+\s*sats|payout route/.test(text)) return "requested";
  return "tracked";
}

function makePayoutLedger({ comments, prsRaw }) {
  const prsByNumber = new Map(prsRaw.map((p) => [Number(p.number), p]));
  const rows = [];
  for (const comment of comments) {
    const body = comment.body || "";
    const isPaymentComment = /(payout|payment)\s+(request|route|acked|sent|paid)|requesting\s+\*{0,2}[0-9,]+\s*sats|paid on-chain/i.test(body);
    if (!isPaymentComment) continue;
    if (!/(sats|bc1|quantum-visualizer\/pull|PR\s*#|txid)/i.test(body)) continue;
    const prNumber = parsePrNumber(body);
    const pr = prNumber ? prsByNumber.get(prNumber) : null;
    const amountSats = parseSats(body);
    const state = inferPayoutState(body);
    rows.push({
      author: comment.user?.login || "unknown",
      created_at: comment.created_at,
      comment_url: comment.html_url,
      pr: prNumber ? `#${prNumber}` : null,
      pr_state: pr?.state || "unknown",
      amount_sats: amountSats,
      btc_address: parseBtcAddress(body),
      txid: parseTxid(body),
      state,
      note: state === "paid"
        ? "Payment proof detected in issue #33 comment."
        : "Not counted as paid until bounty-poster approval and on-chain/payment proof are visible.",
    });
  }

  const requestedRows = rows.filter((r) => r.amount_sats && r.state !== "paid");
  const paidRows = rows.filter((r) => r.amount_sats && r.state === "paid");
  return {
    source_url: "https://github.com/1btc-news/news-client/issues/33",
    extracted_at: new Date().toISOString(),
    rows,
    requested_sats: requestedRows.reduce((sum, r) => sum + r.amount_sats, 0),
    confirmed_paid_sats: paidRows.reduce((sum, r) => sum + r.amount_sats, 0),
    pending_requests: rows.filter((r) => r.state !== "paid").length,
    paid_requests: rows.filter((r) => r.state === "paid").length,
    verifier: "Issue #33 comments plus on-chain BTC transaction proof for each address/txid.",
  };
}

function classifyPr(pr) {
  const mergeable = String(pr.mergeable || "UNKNOWN").toUpperCase();
  const reviewDecision = String(pr.reviewDecision || "").toUpperCase();
  if (pr.isDraft) return { bucket: "draft", next_action: "finish draft, then mark ready for review" };
  if (reviewDecision === "CHANGES_REQUESTED") return { bucket: "author-action", next_action: "address requested changes" };
  if (mergeable === "CONFLICTING") return { bucket: "needs-rebase", next_action: "rebase branch onto current main" };
  if (reviewDecision === "APPROVED" && mergeable === "MERGEABLE") return { bucket: "merge-ready", next_action: "DRI can merge after sequencing" };
  if (mergeable === "MERGEABLE") return { bucket: "review", next_action: "PC/DRI review needed" };
  return { bucket: "triage", next_action: "check mergeability and review state" };
}

function makePrWorkQueue(prsRaw) {
  const open = prsRaw
    .filter((pr) => pr.state === "OPEN")
    .map((pr) => {
      const action = classifyPr(pr);
      return {
        number: pr.number,
        title: pr.title,
        author: pr.author?.login || "unknown",
        url: pr.url,
        head_ref: pr.headRefName,
        updated_at: pr.updatedAt,
        mergeable: pr.mergeable || "UNKNOWN",
        review_decision: pr.reviewDecision || "",
        is_draft: !!pr.isDraft,
        changed_files: pr.changedFiles || 0,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        bucket: action.bucket,
        next_action: action.next_action,
      };
    })
    .sort((a, b) => {
      const order = {
        "merge-ready": 0,
        review: 1,
        "needs-rebase": 2,
        "author-action": 3,
        draft: 4,
        triage: 5,
      };
      return (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9) || Number(b.number) - Number(a.number);
    });

  const countByBucket = open.reduce((acc, pr) => {
    acc[pr.bucket] = (acc[pr.bucket] || 0) + 1;
    return acc;
  }, {});

  return {
    source_url: "https://github.com/Iskander-Agent/quantum-visualizer/pulls",
    extracted_at: new Date().toISOString(),
    open_count: open.length,
    mergeable_count: open.filter((pr) => pr.mergeable === "MERGEABLE").length,
    conflicting_count: open.filter((pr) => pr.mergeable === "CONFLICTING").length,
    needs_review_count: open.filter((pr) => pr.bucket === "review").length,
    merge_ready_count: open.filter((pr) => pr.bucket === "merge-ready").length,
    bucket_counts: countByBucket,
    rows: open,
    next_action: open[0]?.next_action || "No open PRs to triage",
  };
}

const existingCustomer = readExistingCustomer();
const baseCustomer = readBaseCustomer();
const signalsRes = await fetchJSON("https://aibtc.news/api/signals?limit=500");
const allSignals = signalsRes.signals || signalsRes;
const quantum = allSignals.filter((s) => (s.beatSlug || "").includes("quantum"));

const by_agent = {};
for (const s of quantum) by_agent[s.displayName] = (by_agent[s.displayName] || 0) + 1;

const last7dSignals = quantum.filter((s) => (s.utcDate || s.timestamp || "").slice(0, 10) >= sevenDaysAgo);
const last_7d = last7dSignals.length;
const last_7d_by_agent = {};
for (const s of last7dSignals) last_7d_by_agent[s.displayName] = (last_7d_by_agent[s.displayName] || 0) + 1;
const existingQuantumTotal = Math.max(
  Number(existingCustomer?.quantum_beats?.total) || 0,
  Number(baseCustomer?.quantum_beats?.total) || 0
);
const total = Math.max(quantum.length, existingQuantumTotal);
const isPreservingCumulativeTotal = total > quantum.length;
const cumulativeByAgentCandidates = [
  existingCustomer?.quantum_beats?.by_agent,
  baseCustomer?.quantum_beats?.by_agent,
  by_agent,
].filter(Boolean);
const cumulativeByAgent = isPreservingCumulativeTotal
  ? cumulativeByAgentCandidates.sort((a, b) => sumObjectValues(b) - sumObjectValues(a))[0]
  : by_agent;

const comments = JSON.parse(
  gh("gh api repos/1btc-news/news-client/issues/33/comments --paginate")
);
const contributors = [...new Set(comments.map((c) => c.user.login))];
const iskander_comments = comments.filter((c) => c.user.login === "Iskander-Agent").length;

const prsRaw = JSON.parse(
  gh("gh pr list --repo Iskander-Agent/quantum-visualizer --state all --limit 100 --json number,state,author,title,mergedAt,url,isDraft,reviewDecision,mergeable,updatedAt,headRefName,changedFiles,additions,deletions")
);
const merged = prsRaw.filter((p) => p.state === "MERGED");
const pr_contributors = [...new Set(merged.map((p) => p.author.login))];

const revenue = await fetchRevenueLedger(existingCustomer);
const payoutLedger = makePayoutLedger({ comments, prsRaw });
const prWorkQueue = makePrWorkQueue(prsRaw);

const customer = {
  schema_version: 3,
  as_of: today,
  quantum_beats: {
    total,
    by_agent: cumulativeByAgent,
    last_7d,
    last_7d_by_agent,
    source: "https://aibtc.news/api/signals",
    total_source: isPreservingCumulativeTotal
      ? "preserved cumulative floor from prior verified snapshot because current signal response is lower than the historical total"
      : "current aibtc.news signal response",
  },
  sats_flow: {
    bounty_30_paid: {
      amount_sats: 100000,
      txid: "d4648ce29197b0df2bf09658cc93e835f5de69fe2b11febaddf0087f3a568f9b",
      note: "Original research bounty (Issue #30), on-chain proof",
    },
    bounty_33_pool_sats: 250000,
    bounty_33_paid_confirmed: payoutLedger.confirmed_paid_sats,
    bounty_33_payout_ledger: payoutLedger,
    revenue_x402_sats: revenue.totalSats,
    revenue_x402_events: revenue.totalEvents,
    revenue_x402_last_7d_events: revenue.last7dEvents,
    revenue_x402_recent: revenue.events.slice(-5),
    inscription_sales_sats: 0,
  },
  narrative_traction: {
    issue_33_total_comments: comments.length,
    issue_33_unique_participants: contributors.length,
    issue_33_iskander_comments: iskander_comments,
    quantum_visualizer_merged_prs: merged.length,
    quantum_visualizer_pr_contributors: pr_contributors.length,
    pr_contributor_handles: pr_contributors,
    pr_work_queue: prWorkQueue,
    dashboard_visits: "unknown — no analytics instrumented",
    x_engagement: "unknown — x-posting paused (credits depleted)",
  },
  freshness: {
    signals_fetched_at: new Date().toISOString(),
    github_fetched_at: new Date().toISOString(),
    revenue_kv_fetched_at: revenue.fetchedAt,
    next_refresh_target: "weekly synthesis (Sundays)",
  },
  notes: [
    "Silence is not a data point. Unknown fields stay unknown until verified.",
    "Regenerate with: node scripts/build-customer.mjs",
    "bounty_33_payout_ledger is parsed from issue #33 comments. Pending requests are not counted as paid.",
    "narrative_traction.pr_work_queue is parsed from current quantum-visualizer PR state and is an operational queue, not a payout ledger.",
    ...(isPreservingCumulativeTotal ? ["quantum_beats.total is cumulative and must not decrease when the signals API returns a rolling or partial window; last_7d records the current-window count."] : []),
    ...(revenue.note ? [revenue.note] : []),
  ],
};

fs.writeFileSync(OUT, JSON.stringify(customer, null, 2) + "\n");
console.log(`wrote customer.json: ${total} cumulative beats (${quantum.length} current response, ${last_7d} last 7d), ${comments.length} comments, ${merged.length} merged PRs, ${prWorkQueue.open_count} open PRs, ${revenue.totalEvents} x402 events (${revenue.totalSats} sats), ${payoutLedger.rows.length} payout rows`);
