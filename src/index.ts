const QV_SERVICE_STX = "SP2D26THR4EFBY7PH9JXTG8V2XYM7SZGVTVW1Q572";
const SBTC_ASSET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const NETWORK = "stacks:1";
const PRICE_SATS = "100";
const RELAY_BASE = "https://x402-relay.aibtc.com";
const RELAY_SETTLE = `${RELAY_BASE}/settle`;
const RELAY_HEALTH = `${RELAY_BASE}/health`;
const HIRO_BASE = "https://api.hiro.so";
const DIRECT_POLL_MAX_MS = 8000;
const DIRECT_POLL_INTERVAL_MS = 1000;
const REPLAY_MARKER_VALUE = "1";

interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

type BroadcastMode = "sponsored-relay" | "direct";

function buildAcceptsList(): PaymentRequirements[] {
  const base = {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_SATS,
    asset: SBTC_ASSET,
    payTo: QV_SERVICE_STX,
    maxTimeoutSeconds: 60,
  };
  return [
    {
      ...base,
      extra: {
        broadcast: "sponsored-relay",
        relay: RELAY_BASE,
        note: "Caller signs sponsored sBTC transfer (sponsored:true fee:0). Relay broadcasts and pays STX gas.",
      },
    },
    {
      ...base,
      extra: {
        broadcast: "direct",
        verifier: "hiro",
        note: "Caller broadcasts the sBTC transfer directly to Stacks (own STX gas). Then submit the 0x-prefixed txid as payload.transaction. Worker verifies on-chain via Hiro.",
        instructions: "1. Build sBTC transfer (sponsored:false, fee=10000 microSTX is plenty). 2. Broadcast via your own Stacks RPC or https://api.hiro.so/v2/transactions. 3. Wait for tx_status=success. 4. POST/GET this endpoint with payment-signature header containing { x402Version:2, accepted:<the direct option>, payload:{ transaction: '0x<txid>' } }.",
      },
    },
  ];
}

function serverRequirementForMode(mode: BroadcastMode): PaymentRequirements {
  const requirement = buildAcceptsList().find((item) => item.extra?.broadcast === mode);
  if (!requirement) throw new Error(`missing payment requirement for ${mode}`);
  return requirement;
}

function stripRelayMetadata(requirement: PaymentRequirements): Omit<PaymentRequirements, "extra"> {
  const { extra: _extra, ...settlementRequirement } = requirement;
  return settlementRequirement;
}

function buildPaymentRequired(resourceUrl: string, description: string): PaymentRequiredV2 {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: buildAcceptsList(),
  };
}

function b64encode(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

function b64decode<T = unknown>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(atob(s)); } catch { return null; }
}

function normalizePaymentTxid(value: unknown): string | null {
  const raw = String(value || "").trim();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return /^[0-9a-f]{64}$/i.test(hex) ? "0x" + hex.toLowerCase() : null;
}

function normalizeSubmittedTxid(payload: any): string | null {
  return normalizePaymentTxid(payload?.payload?.transaction);
}

function replayKey(txid: string): string {
  const normalized = normalizePaymentTxid(txid);
  return "txid:" + (normalized || txid.trim().toLowerCase());
}

function paymentRequiredResponse(req: Request, description: string, extraBody?: Record<string, unknown>): Response {
  const url = new URL(req.url);
  const required = buildPaymentRequired(url.toString(), description);
  return new Response(JSON.stringify({
    x402Version: 2,
    error: extraBody?.error || "payment_required",
    accepts: required.accepts,
    resource: required.resource,
    ...(extraBody || {}),
  }), {
    status: 402,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "payment-required": b64encode(required),
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "payment-required, payment-response",
    },
  });
}

async function settleWithRelay(paymentPayload: any): Promise<{ success: boolean; txid: string; payer?: string; reason?: string; held?: any; raw: any }> {
  const accepted = serverRequirementForMode("sponsored-relay");
  const body = {
    x402Version: 2,
    paymentPayload: {
      ...paymentPayload,
      accepted,
    },
    paymentRequirements: stripRelayMetadata(accepted),
  };
  const res = await fetch(RELAY_SETTLE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return {
    success: !!json.success,
    txid: json.transaction || "",
    payer: json.payer,
    reason: json.errorReason,
    held: json.queue?.status === "held" ? json.queue : undefined,
    raw: json,
  };
}

interface DirectVerifyResult {
  success: boolean;
  txid: string;
  payer?: string;
  reason?: string;
  raw?: any;
}

async function verifyDirect(payload: any): Promise<DirectVerifyResult> {
  const txid = normalizeSubmittedTxid(payload);
  if (!txid) {
    return { success: false, reason: "invalid_txid", txid: "", raw: { hint: "payload.transaction must be 0x-prefixed 64-char hex (the txid)" } };
  }
  const deadline = Date.now() + DIRECT_POLL_MAX_MS;
  let lastTx: any = null;
  while (Date.now() < deadline) {
    const r = await fetch(`${HIRO_BASE}/extended/v1/tx/${txid}`);
    if (r.ok) {
      lastTx = await r.json();
      if (lastTx.tx_status === "success") break;
      if (lastTx.tx_status && lastTx.tx_status !== "pending") {
        return { success: false, reason: `tx_status:${lastTx.tx_status}`, txid, raw: lastTx };
      }
    }
    await new Promise((r) => setTimeout(r, DIRECT_POLL_INTERVAL_MS));
  }
  if (!lastTx || lastTx.tx_status !== "success") {
    return { success: false, reason: "tx_not_confirmed_within_8s", txid, raw: lastTx };
  }

  if (lastTx.tx_type !== "contract_call") {
    return { success: false, reason: "not_a_contract_call", txid, raw: lastTx };
  }
  const cc = lastTx.contract_call;
  if (cc.contract_id !== SBTC_ASSET) {
    return { success: false, reason: "wrong_contract", txid, raw: { expected: SBTC_ASSET, got: cc.contract_id } };
  }
  if (cc.function_name !== "transfer") {
    return { success: false, reason: "wrong_function", txid, raw: { got: cc.function_name } };
  }

  const args = cc.function_args || [];
  const amountArg = args.find((a: any) => a.name === "amount") || args[0];
  const recipientArg = args.find((a: any) => a.name === "recipient") || args[2];
  const amountRepr = String(amountArg?.repr || "");
  const recipientRepr = String(recipientArg?.repr || "");
  const amountMatch = amountRepr.match(/^u(\d+)$/);
  const amountValue = amountMatch ? BigInt(amountMatch[1]) : 0n;
  const minAmount = BigInt(PRICE_SATS);
  if (amountValue < minAmount) {
    return { success: false, reason: "amount_below_minimum", txid, raw: { required: PRICE_SATS, got: amountRepr } };
  }
  const recipientPrincipal = recipientRepr.replace(/^'/, "").trim();
  if (recipientPrincipal !== QV_SERVICE_STX) {
    return { success: false, reason: "wrong_recipient", txid, raw: { expected: QV_SERVICE_STX, got: recipientPrincipal } };
  }

  return { success: true, txid, payer: lastTx.sender_address, raw: { confirmed_at: lastTx.burn_block_time_iso || null, fee_micro_stx: lastTx.fee_rate } };
}

async function loadData(env: any, request: Request): Promise<any> {
  const dataUrl = new URL("/data.json", request.url);
  const r = await env.ASSETS.fetch(new Request(dataUrl.toString()));
  if (!r.ok) throw new Error("data.json fetch failed");
  return r.json();
}

function topUrgentSlice(data: any) {
  const ranked = data.developers
    .filter((d: any) => d.quantum_urgency_score >= 4)
    .sort((a: any, b: any) => b.quantum_urgency_score - a.quantum_urgency_score || a.rank - b.rank)
    .slice(0, 5);
  return {
    schema: "premium.top_urgent.v1",
    as_of: data.metadata.last_updated || data.metadata.date,
    count: ranked.length,
    developers: ranked.map((d: any) => ({
      name: d.name, affiliation: d.affiliation, role: d.role,
      score: d.quantum_urgency_score, pq_work_volume: d.pq_work_volume,
      summary: d.summary, key_source: d.key_source, sources: d.sources,
      last_verified: d.last_verified,
    })),
  };
}

function indexBreakdownSlice(data: any) {
  const idx = data.metadata.quantum_readiness_index || {};
  const voiced = data.developers
    .filter((d: any) => d.quantum_urgency_score >= 2)
    .map((d: any) => ({ name: d.name, score: d.quantum_urgency_score, key_source: d.key_source }));
  const silent = data.developers
    .filter((d: any) => d.quantum_urgency_score === 1)
    .map((d: any) => ({ name: d.name, affiliation: d.affiliation }));
  return {
    schema: "premium.index_breakdown.v1",
    as_of: data.metadata.last_updated || data.metadata.date,
    index: idx,
    voiced, silent,
  };
}

function devSlice(data: any, name: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(name);
  const dev = data.developers.find((d: any) => {
    const n = norm(d.name);
    return n.includes(target) || target.includes(n);
  });
  if (!dev) return null;
  return { schema: "premium.dev.v1", as_of: data.metadata.last_updated || data.metadata.date, developer: dev };
}

function sinceSlice(data: any, sinceDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) return null;
  const history = (data.metadata.update_history || []).filter((h: any) => h.date >= sinceDate);
  const affected = [...new Set(history.map((h: any) => h.developer))];
  return {
    schema: "premium.since.v1",
    as_of: data.metadata.last_updated || data.metadata.date,
    since: sinceDate,
    count: history.length,
    history,
    affected_developers: affected,
  };
}

function isIsoDate(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeSearchValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseHistoryLimit(value: string | null): number {
  const fallback = 100;
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function summarizeHistoryVersions(history: any[]) {
  const byDate = new Map<string, any>();
  for (const entry of history) {
    const date = String(entry.date || "unknown");
    const version = byDate.get(date) || {
      version_id: `history-${date}`,
      date,
      entry_count: 0,
      developers: new Set<string>(),
      prs: new Set<string>(),
      contributors: new Set<string>(),
    };
    version.entry_count++;
    if (entry.developer) version.developers.add(entry.developer);
    if (entry.pr) version.prs.add(entry.pr);
    if (entry.contributor) version.contributors.add(entry.contributor);
    byDate.set(date, version);
  }

  return [...byDate.values()].map((version) => ({
    version_id: version.version_id,
    date: version.date,
    entry_count: version.entry_count,
    developers: [...version.developers],
    prs: [...version.prs],
    contributors: [...version.contributors],
  }));
}

async function handleCompanyHistory(req: Request, env: any, versionDate?: string): Promise<Response> {
  const data = await loadData(env, req);
  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const developer = url.searchParams.get("developer")?.trim() || "";
  const requestedVersion = versionDate || url.searchParams.get("version");

  if (since && !isIsoDate(since)) {
    return jsonResponse({ error: "invalid_since", hint: "Use YYYY-MM-DD." }, 400, "no-store");
  }
  if (until && !isIsoDate(until)) {
    return jsonResponse({ error: "invalid_until", hint: "Use YYYY-MM-DD." }, 400, "no-store");
  }
  if (requestedVersion && !isIsoDate(requestedVersion)) {
    return jsonResponse({ error: "invalid_version", hint: "Use /api/world/company/history/YYYY-MM-DD." }, 400, "no-store");
  }

  const rawHistory = Array.isArray(data.metadata?.update_history) ? data.metadata.update_history : [];
  const developerNeedle = developer ? normalizeSearchValue(developer) : "";
  let filtered = rawHistory.map((entry: any, index: number) => ({
    sequence: index + 1,
    ...entry,
  }));

  if (requestedVersion) filtered = filtered.filter((entry: any) => entry.date === requestedVersion);
  if (since) filtered = filtered.filter((entry: any) => entry.date >= since);
  if (until) filtered = filtered.filter((entry: any) => entry.date <= until);
  if (developerNeedle) {
    filtered = filtered.filter((entry: any) => normalizeSearchValue(String(entry.developer || "")).includes(developerNeedle));
  }

  const limit = parseHistoryLimit(url.searchParams.get("limit"));
  const history = filtered.slice(Math.max(filtered.length - limit, 0));
  const versions = summarizeHistoryVersions(filtered);
  const latestEntry = rawHistory[rawHistory.length - 1] || null;

  return jsonResponse({
    schema: "company.history.v1",
    as_of: data.metadata?.last_updated || data.metadata?.date || null,
    snapshot: {
      version: data.metadata?.version || null,
      date: data.metadata?.date || null,
      last_updated: data.metadata?.last_updated || null,
      total_assessed: data.metadata?.total_assessed || null,
      latest_update_date: latestEntry?.date || null,
      total_history_entries: rawHistory.length,
    },
    filters: {
      version: requestedVersion || null,
      since: since || null,
      until: until || null,
      developer: developer || null,
      limit,
    },
    count: history.length,
    filtered_count: filtered.length,
    order: "chronological",
    versions,
    history,
  });
}

function daysBetween(date: unknown, asOf: string): number | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = Date.parse(`${date}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 86400000));
}

function companyFreshnessSlice(data: any) {
  const asOf = data.metadata?.last_updated || data.metadata?.date || new Date().toISOString().slice(0, 10);
  const developers = Array.isArray(data.developers) ? data.developers : [];
  const total = Math.max(1, Number(data.metadata?.total_assessed) || developers.length || 1);
  const staleThresholdDays = 30;
  const verified = developers.filter((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(d.last_verified || ""));
  const sourced = developers.filter((d: any) => Array.isArray(d.sources) && d.sources.length > 0);
  const stale = developers
    .map((d: any) => ({
      name: d.name,
      rank: d.rank ?? null,
      affiliation: d.affiliation || null,
      score: d.quantum_urgency_score ?? null,
      last_verified: d.last_verified || null,
      age_days: daysBetween(d.last_verified, asOf),
      key_source: d.key_source || null,
    }))
    .filter((d: any) => d.age_days === null || d.age_days > staleThresholdDays)
    .sort((a: any, b: any) => (b.age_days ?? 9999) - (a.age_days ?? 9999));
  const history = Array.isArray(data.metadata?.update_history) ? data.metadata.update_history : [];

  return {
    schema: "company.freshness.v1",
    as_of: asOf,
    stale_threshold_days: staleThresholdDays,
    totals: {
      developers: developers.length,
      verified: verified.length,
      verified_percent: Math.round((verified.length / total) * 100),
      sourced: sourced.length,
      sourced_percent: Math.round((sourced.length / total) * 100),
      stale: stale.length,
    },
    stale_developers: stale.slice(0, 25),
    recent_updates: history.slice().reverse().slice(0, 10),
    next_actions: stale.slice(0, 5).map((d: any) => ({
      developer: d.name,
      action: d.age_days === null
        ? "Add a last_verified date after checking primary sources."
        : `Re-verify primary sources; last check is ${d.age_days} days old.`,
    })),
  };
}

async function handlePremium(req: Request, env: any, slug: string, sliceFn: (data: any) => any | null): Promise<Response> {
  const description = "Quantum Visualizer premium slice: " + slug;
  const sigHeader = req.headers.get("payment-signature");
  if (!sigHeader) return paymentRequiredResponse(req, description);

  const payload = b64decode<any>(sigHeader);
  if (!payload || !payload.payload?.transaction) {
    return paymentRequiredResponse(req, description, { error: "invalid_payment_signature" });
  }

  const broadcastMode = String(payload?.accepted?.extra?.broadcast || "sponsored-relay");

  const submittedTxid = normalizeSubmittedTxid(payload);
  if (broadcastMode === "direct" && submittedTxid) {
    const seen = await env.REVENUE_LOG.get(replayKey(submittedTxid));
    if (seen) {
      return new Response(JSON.stringify({
        x402Version: 2,
        error: "replay_detected",
        txid: submittedTxid,
      }), {
        status: 409,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
  }

  let outcome: { success: boolean; txid: string; payer?: string; reason?: string; held?: any; raw?: any };
  if (broadcastMode === "direct") {
    outcome = await verifyDirect(payload);
  } else {
    outcome = await settleWithRelay(payload);
  }

  const settledTxid = normalizePaymentTxid(outcome.txid);
  if (!outcome.success || !settledTxid) {
    const advice = outcome.held
      ? "Relay queue is held for your sender (nonce desync). Switch to broadcast=direct: build a non-sponsored sBTC transfer with your own STX gas, broadcast via Hiro, then submit 0x{txid} as payload.transaction."
      : broadcastMode === "direct"
        ? "Direct verification failed. Confirm the txid is for an sBTC transfer of >=100 sats to " + QV_SERVICE_STX + ", confirmed on mainnet."
        : "Settlement failed. See `relay` field. You may try broadcast=direct as a fallback.";
    return paymentRequiredResponse(req, description, {
      error: "settlement_failed",
      attempted_mode: broadcastMode,
      reason: outcome.reason || (settledTxid ? "unknown" : "invalid_settlement_txid"),
      held: outcome.held || null,
      relay: broadcastMode === "sponsored-relay" ? outcome.raw : undefined,
      verifier: broadcastMode === "direct" ? outcome.raw : undefined,
      advice,
      doctor: "/api/world/premium/doctor",
    });
  }

  const txKey = replayKey(settledTxid);
  const seen = await env.REVENUE_LOG.get(txKey);
  if (seen) {
    return new Response(JSON.stringify({
      x402Version: 2,
      error: "replay_detected",
      txid: settledTxid,
    }), {
      status: 409,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  const data = await loadData(env, req);
  const slice = sliceFn(data);
  if (!slice) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const event = {
    ts: new Date().toISOString(),
    slug,
    txid: settledTxid,
    payer: outcome.payer || null,
    sats: Number(PRICE_SATS),
    mode: broadcastMode,
  };
  await env.REVENUE_LOG.put(txKey, REPLAY_MARKER_VALUE);

  const ledgerKey = "ledger:events";
  const ledgerRaw = await env.REVENUE_LOG.get(ledgerKey);
  const ledger: any[] = ledgerRaw ? JSON.parse(ledgerRaw) : [];
  ledger.push(event);
  await env.REVENUE_LOG.put(ledgerKey, JSON.stringify(ledger));

  const settlementResponse = {
    success: true,
    transaction: settledTxid,
    network: NETWORK,
    payer: outcome.payer || "",
  };
  return new Response(JSON.stringify({
    ...slice,
    payment: { txid: settledTxid, sats: Number(PRICE_SATS), payer: outcome.payer || null, mode: broadcastMode },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "payment-response": b64encode(settlementResponse),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "payment-response",
    },
  });
}

async function handleDoctor(_req: Request, env: any): Promise<Response> {
  const probedAt = new Date().toISOString();
  let relayHealth: any;
  try {
    const r = await fetch(RELAY_HEALTH, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j: any = await r.json();
      relayHealth = { reachable: true, status: j.status || "unknown", version: j.version || null, network: j.network || null, raw: j };
    } else {
      relayHealth = { reachable: false, http_status: r.status };
    }
  } catch (e: any) {
    relayHealth = { reachable: false, error: String(e?.message || e) };
  }

  let ledgerStats: any = null;
  try {
    const ledgerRaw = await env.REVENUE_LOG.get("ledger:events");
    const ledger: any[] = ledgerRaw ? JSON.parse(ledgerRaw) : [];
    ledgerStats = { total_events: ledger.length, total_sats: ledger.reduce((s, e) => s + (e.sats || 0), 0), modes: ledger.reduce((acc: any, e: any) => { acc[e.mode || "unknown"] = (acc[e.mode || "unknown"] || 0) + 1; return acc; }, {}) };
  } catch {
    ledgerStats = { error: "ledger_unavailable" };
  }

  const recommended = relayHealth.reachable && relayHealth.status === "ok" ? "sponsored-relay" : "direct";

  const doctor = {
    schema_version: 1,
    service: "Quantum Visualizer paid x402 endpoints",
    probed_at: probedAt,
    price_sats: Number(PRICE_SATS),
    asset: SBTC_ASSET,
    pay_to: QV_SERVICE_STX,
    network: NETWORK,
    endpoints: {
      "/api/world/premium/top-urgent": "Top 5 urgent devs (score 4–5) with quotes + sources",
      "/api/world/premium/index-breakdown": "Quantum Readiness Index w/ voiced + silent dev lists",
      "/api/world/premium/dev/{name}": "Single dev profile by fuzzy name match",
      "/api/world/premium/since/{YYYY-MM-DD}": "Update history entries since date",
      "/api/world/company/freshness": "Free operational freshness audit for the company world model",
      "/api/world/company/history": "Free versioned update-history view (supports since/until/developer/limit filters)",
      "/api/world/company/history/{YYYY-MM-DD}": "Update entries for a specific date",
    },
    schemes: [
      {
        id: "sponsored-relay",
        broadcast: "via aibtc x402 relay",
        caller_pays_gas: false,
        relay: RELAY_BASE,
        relay_health: relayHealth,
        advice: relayHealth.reachable && relayHealth.status === "ok"
          ? "Relay healthy. Default choice — caller signs sponsored:true fee:0, relay broadcasts and pays STX gas."
          : "Relay UNHEALTHY or unreachable right now. Use direct mode instead.",
      },
      {
        id: "direct",
        broadcast: "caller broadcasts to Stacks chain themselves",
        caller_pays_gas: true,
        verifier: "hiro",
        advice: "Always available. Caller signs sponsored:false with own STX fee (~10000 microSTX), broadcasts, waits for tx_status=success, then submits 0x{txid} as payload.transaction. Worker verifies the on-chain tx is an sBTC transfer of >=100 sats to " + QV_SERVICE_STX + ".",
      },
    ],
    recommended_default: recommended,
    fallback_advice: "If a sponsored-relay attempt returns 402 with held=true (relay queue desynced for your sender), retry the same call as broadcast=direct. Each call's reply includes specific advice.",
    revenue_ledger: ledgerStats,
    notes: [
      "Replay protection: each settled txid is single-use.",
      "All sats settle to a dedicated service wallet — separate from any operator's main wallet.",
      "Free, no-payment endpoints: /api/world/company, /api/world/company/freshness, /api/world/company/history, /api/world/customer, /api/world/premium/doctor.",
    ],
  };

  return new Response(JSON.stringify(doctor, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/world/company") return proxyJson(env, request, "/data.json");
    if (p === "/api/world/company/freshness") {
      const data = await loadData(env, request);
      return jsonResponse(companyFreshnessSlice(data));
    }
    if (p === "/api/world/company/history") return handleCompanyHistory(request, env);
    const companyHistoryMatch = p.match(/^\/api\/world\/company\/history\/(\d{4}-\d{2}-\d{2})$/);
    if (companyHistoryMatch) return handleCompanyHistory(request, env, companyHistoryMatch[1]);
    if (p === "/api/world/customer") return proxyJson(env, request, "/customer.json");
    if (p === "/api/world/premium/doctor") return handleDoctor(request, env);

    if (p === "/api/world/premium/top-urgent") {
      return handlePremium(request, env, "top-urgent", topUrgentSlice);
    }
    if (p === "/api/world/premium/index-breakdown") {
      return handlePremium(request, env, "index-breakdown", indexBreakdownSlice);
    }
    const devMatch = p.match(/^\/api\/world\/premium\/dev\/(.+)$/);
    if (devMatch) {
      const name = decodeURIComponent(devMatch[1]);
      return handlePremium(request, env, "dev/" + name, (d) => devSlice(d, name));
    }
    const sinceMatch = p.match(/^\/api\/world\/premium\/since\/(\d{4}-\d{2}-\d{2})$/);
    if (sinceMatch) {
      const date = sinceMatch[1];
      return handlePremium(request, env, "since/" + date, (d) => sinceSlice(d, date));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return assetResponse;

    let totalAssessed: string;
    try {
      const dataUrl = new URL("/data.json", request.url);
      const dataResponse = await env.ASSETS.fetch(new Request(dataUrl.toString()));
      if (!dataResponse.ok) throw new Error("data.json fetch failed");
      const data: any = await dataResponse.json();
      totalAssessed = String(data.metadata.total_assessed);
    } catch {
      totalAssessed = "55";
    }

    const html = await assetResponse.text();
    const rendered = html.replaceAll("__TOTAL_ASSESSED__", totalAssessed);
    const headers = new Headers(assetResponse.headers);
    headers.set("cache-control", "public, max-age=60");
    return new Response(rendered, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
};

function jsonResponse(body: unknown, status = 200, cacheControl = "public, max-age=300"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
      "access-control-allow-origin": "*",
    },
  });
}

async function proxyJson(env: any, request: Request, assetPath: string): Promise<Response> {
  const assetUrl = new URL(assetPath, request.url);
  const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
  if (!res.ok) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const body = await res.text();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
