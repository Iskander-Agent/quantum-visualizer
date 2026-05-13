#!/usr/bin/env node
// Build public/customer.json - Customer World Model snapshot.
// Pulls from aibtc.news signals API, GitHub #33 comments, quantum-visualizer PRs,
// and the REVENUE_LOG KV namespace when Cloudflare credentials are available.
// Fields we cannot verify are explicitly "unknown"; never fabricate missing state.
import fs from "fs";
import { execSync } from "child_process";

const OUT = new URL("../public/customer.json", import.meta.url);
const today = new Date().toISOString().slice(0, 10);
const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const projectStart = "2026-04-04";

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

function readExistingCustomer() {
  try {
    return JSON.parse(fs.readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
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

function daysBetween(a, b) {
  return Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function stateLabel(state) {
  return String(state || "UNKNOWN").toLowerCase();
}

function makeTeamWeek({ quantum, comments, prsRaw, weekNumber, weekStart, weekEnd }) {
  const rows = [];
  const signalsThisWeek = quantum.filter((s) => (s.utcDate || s.timestamp || "").slice(0, 10) >= weekStart);
  const beatsByAgent = new Map();
  for (const signal of signalsThisWeek) {
    const name = signal.displayName || "Unknown agent";
    const entry = beatsByAgent.get(name) || { count: 0, accepted: 0, submitted: 0 };
    entry.count += 1;
    if (signal.status === "accepted") entry.accepted += 1;
    if (signal.status === "submitted") entry.submitted += 1;
    beatsByAgent.set(name, entry);
  }
  [...beatsByAgent.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .forEach(([agent, counts]) => {
      rows.push({
        role: "Daily Beat Writer",
        agent,
        output: `${plural(counts.count, "quantum beat")} filed (${counts.accepted} accepted, ${counts.submitted} submitted)`,
        status: counts.accepted ? "accepted" : "submitted",
        source_url: "https://aibtc.news/api/signals?limit=500",
      });
    });

  const prsThisWeek = prsRaw.filter((p) => [p.createdAt, p.updatedAt, p.mergedAt].some((v) => (v || "").slice(0, 10) >= weekStart));
  const prsByAuthor = new Map();
  for (const pr of prsThisWeek) {
    const author = pr.author?.login || "unknown";
    const list = prsByAuthor.get(author) || [];
    list.push(pr);
    prsByAuthor.set(author, list);
  }
  [...prsByAuthor.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .forEach(([agent, prs]) => {
      const merged = prs.filter((p) => p.state === "MERGED").length;
      const open = prs.filter((p) => p.state === "OPEN").length;
      const closed = prs.filter((p) => p.state === "CLOSED").length;
      const refs = prs.map((p) => `#${p.number} ${stateLabel(p.state)}`).join(", ");
      rows.push({
        role: "Visualizer Developer",
        agent,
        output: `${plural(prs.length, "dashboard PR")} this week: ${refs}`,
        status: merged ? "merged" : open ? "open" : closed ? "closed" : "tracked",
        source_url: prs[0]?.url || "https://github.com/Iskander-Agent/quantum-visualizer/pulls",
      });
    });

  const commentsThisWeek = comments.filter((c) => (c.created_at || "").slice(0, 10) >= weekStart);
  const driComments = commentsThisWeek.filter((c) => c.user?.login === "Iskander-Agent" && /DRI|daily|status|synthesis/i.test(c.body || ""));
  const latestDri = driComments.at(-1);
  rows.push({
    role: "Directly Responsible Individual",
    agent: "Iskander-Agent",
    output: latestDri ? `${plural(driComments.length, "coordination update")} in #33` : "No DRI issue update detected this week",
    status: latestDri ? "active" : "needs update",
    source_url: latestDri?.html_url || "https://github.com/1btc-news/news-client/issues/33",
  });

  for (const handle of ["ThankNIXlater", "lekanbams"]) {
    const pcComments = commentsThisWeek.filter((c) => c.user?.login === handle && /PC|review|clearance|verdict|merge/i.test(c.body || ""));
    if (!pcComments.length) continue;
    rows.push({
      role: "Player Coach / Review",
      agent: handle,
      output: `${plural(pcComments.length, "review update")} in #33`,
      status: "active",
      source_url: pcComments.at(-1).html_url,
    });
  }

  const tableRequest = [...comments].reverse().find((c) => /Team\s+[-\u2013\u2014]\s+Week|week[- ]?#[\s\S]*table|source of truth for the weeks|weekly stats/i.test(c.body || ""));

  return {
    label: `Week ${weekNumber}`,
    week_number: weekNumber,
    week_start: weekStart,
    week_end: weekEnd,
    source_request_url: tableRequest?.html_url || null,
    source_request_author: tableRequest?.user?.login || null,
    rows,
  };
}

const existingCustomer = readExistingCustomer();
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
  gh("gh pr list --repo Iskander-Agent/quantum-visualizer --state all --limit 100 --json number,state,author,title,mergedAt,createdAt,updatedAt,url")
);
const merged = prsRaw.filter((p) => p.state === "MERGED");
const pr_contributors = [...new Set(merged.map((p) => p.author.login))];

const weekNumber = Math.max(1, Math.floor(daysBetween(projectStart, today) / 7) + 1);
const weekStart = addDays(projectStart, (weekNumber - 1) * 7);
const weekEnd = addDays(weekStart, 6);
const teamWeek = makeTeamWeek({ quantum, comments, prsRaw, weekNumber, weekStart, weekEnd });

const revenue = await fetchRevenueLedger(existingCustomer);

const customer = {
  schema_version: 3,
  as_of: today,
  quantum_beats: {
    total: quantum.length,
    by_agent,
    last_7d,
    source: "https://aibtc.news/api/signals",
  },
  team_week: teamWeek,
  sats_flow: {
    bounty_30_paid: {
      amount_sats: 100000,
      txid: "d4648ce29197b0df2bf09658cc93e835f5de69fe2b11febaddf0087f3a568f9b",
      note: "Original research bounty (Issue #30), on-chain proof",
    },
    bounty_33_pool_sats: 250000,
    bounty_33_paid_confirmed: "unknown - awaiting on-chain payout ledger in #33",
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
    dashboard_visits: "unknown - no analytics instrumented",
    x_engagement: "unknown - x-posting paused (credits depleted)",
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
    ...(revenue.note ? [revenue.note] : []),
  ],
};

fs.writeFileSync(OUT, JSON.stringify(customer, null, 2) + "\n");
console.log(`wrote customer.json: ${quantum.length} beats, ${comments.length} comments, ${merged.length} merged PRs, ${revenue.totalEvents} x402 events (${revenue.totalSats} sats)`);
