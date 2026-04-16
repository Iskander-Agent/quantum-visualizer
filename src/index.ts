const ISKANDER_STX = "SP3JR7JXFT7ZM9JKSQPBQG1HPT0D365MA5TN0P12E";
const SBTC_ASSET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const NETWORK = "stacks:1";
const PRICE_SATS = "100";
const RELAY_SETTLE = "https://x402-relay.aibtc.com/settle";
const REPLAY_TTL_SECONDS = 60 * 60 * 24;

interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

function buildRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_SATS,
    asset: SBTC_ASSET,
    payTo: ISKANDER_STX,
    maxTimeoutSeconds: 60,
  };
}

function buildPaymentRequired(resourceUrl: string, description: string): PaymentRequiredV2 {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [buildRequirements()],
  };
}

function b64encode(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

function b64decode<T = unknown>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(atob(s)); } catch { return null; }
}

function paymentRequiredResponse(req: Request, description: string): Response {
  const url = new URL(req.url);
  const required = buildPaymentRequired(url.toString(), description);
  return new Response(JSON.stringify({
    x402Version: 2,
    error: "payment_required",
    accepts: required.accepts,
    resource: required.resource,
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

async function settleWithRelay(paymentPayload: unknown): Promise<{ success: boolean; txid: string; payer?: string; reason?: string; raw: any }> {
  const body = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: buildRequirements(),
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
    raw: json,
  };
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
      name: d.name,
      affiliation: d.affiliation,
      role: d.role,
      score: d.quantum_urgency_score,
      pq_work_volume: d.pq_work_volume,
      summary: d.summary,
      key_source: d.key_source,
      sources: d.sources,
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
    voiced,
    silent,
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
  return {
    schema: "premium.dev.v1",
    as_of: data.metadata.last_updated || data.metadata.date,
    developer: dev,
  };
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

async function handlePremium(req: Request, env: any, slug: string, sliceFn: (data: any) => any | null): Promise<Response> {
  const description = "Quantum Visualizer premium slice: " + slug;
  const sigHeader = req.headers.get("payment-signature");
  if (!sigHeader) return paymentRequiredResponse(req, description);

  const payload = b64decode<any>(sigHeader);
  if (!payload || !payload.payload?.transaction) {
    return paymentRequiredResponse(req, description);
  }

  const settle = await settleWithRelay(payload);
  if (!settle.success || !settle.txid) {
    return new Response(JSON.stringify({
      x402Version: 2,
      error: "settlement_failed",
      reason: settle.reason || "unknown",
      relay: settle.raw,
    }), {
      status: 402,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "payment-required": b64encode(buildPaymentRequired(new URL(req.url).toString(), description)),
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "payment-required, payment-response",
      },
    });
  }

  const txKey = "txid:" + settle.txid;
  const seen = await env.REVENUE_LOG.get(txKey);
  if (seen) {
    return new Response(JSON.stringify({
      x402Version: 2,
      error: "replay_detected",
      txid: settle.txid,
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
    txid: settle.txid,
    payer: settle.payer || null,
    sats: Number(PRICE_SATS),
  };

  await env.REVENUE_LOG.put(txKey, JSON.stringify(event), { expirationTtl: REPLAY_TTL_SECONDS });

  const ledgerKey = "ledger:events";
  const ledgerRaw = await env.REVENUE_LOG.get(ledgerKey);
  const ledger: any[] = ledgerRaw ? JSON.parse(ledgerRaw) : [];
  ledger.push(event);
  await env.REVENUE_LOG.put(ledgerKey, JSON.stringify(ledger));

  const settlementResponse = {
    success: true,
    transaction: settle.txid,
    network: NETWORK,
    payer: settle.payer || "",
  };
  return new Response(JSON.stringify({
    ...slice,
    payment: { txid: settle.txid, sats: Number(PRICE_SATS), payer: settle.payer || null },
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

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/world/company") return proxyJson(env, request, "/data.json");
    if (p === "/api/world/customer") return proxyJson(env, request, "/customer.json");

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
