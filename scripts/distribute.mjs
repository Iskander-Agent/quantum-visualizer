#!/usr/bin/env node
/**
 * Quantum Visualizer Revenue Distribution — Monthly sBTC Payout
 *
 * Reads ledger stats from the live /api/world/revenue/contributors endpoint,
 * calculates per-endpoint splits, and broadcasts sBTC transfer transactions
 * for contributor payout.
 *
 * Usage:
 *   node scripts/distribute.mjs [--preview] [--broadcast]
 *
 * --preview: show payout table without signing (default)
 * --broadcast: sign and broadcast transfers
 *
 * Required env for --broadcast:
 *   QV_STX_PRIVATE_KEY  — hex private key for SP2D26THR4EFBY7PH9JXTG8V2XYM7SZGVTVW1Q572
 *                         (never commit; load from secrets manager or shell: export QV_STX_PRIVATE_KEY=...)
 *
 * Optional env:
 *   QV_WORKER_URL       — override deployed worker URL (default: https://quantum-power-map.ghislo.workers.dev)
 */

import { readFileSync } from "fs";

const MANIFEST_PATH = "./data/contributors.json";
const SERVICE_WALLET = "SP2D26THR4EFBY7PH9JXTG8V2XYM7SZGVTVW1Q572";
const SBTC_CONTRACT_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_NAME = "sbtc-token";
const SBTC_ASSET_NAME = "sbtc-token"; // fungible token name defined in the contract
const HIRO_API = "https://api.hiro.so";
const WORKER_URL = process.env.QV_WORKER_URL ?? "https://quantum-power-map.ghislo.workers.dev";

const args = process.argv.slice(2);
const shouldBroadcast = args.includes("--broadcast");

console.log(`\n📊 Quantum Visualizer Revenue Distribution\n`);
console.log(`Mode:    ${shouldBroadcast ? "BROADCAST" : "PREVIEW"}`);
console.log(`Worker:  ${WORKER_URL}`);
console.log(`Updated: ${new Date().toISOString()}\n`);

try {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  // Fetch live ledger stats from the free endpoint (reads CF KV REVENUE_LOG internally)
  const statsEndpoint = `${WORKER_URL}/api/world/revenue/contributors`;
  console.log(`Fetching ledger stats from ${statsEndpoint}...`);
  const statsRes = await fetch(statsEndpoint);
  if (!statsRes.ok) {
    throw new Error(`Ledger fetch failed: ${statsRes.status} ${await statsRes.text()}`);
  }
  const { stats, total_sats_collected, ledger_entries } = await statsRes.json();
  console.log(`  ${ledger_entries} ledger entries, ${total_sats_collected} sats total\n`);

  if (ledger_entries === 0) {
    console.log("ℹ No ledger events found — nothing to distribute.\n");
    if (!shouldBroadcast) {
      console.log("📋 Preview mode — no transactions signed or broadcast.\n");
    }
    process.exit(0);
  }

  const payouts = new Map();

  for (const [slug, stat] of Object.entries(stats)) {
    const endpoint = manifest.endpoints[slug];
    if (!endpoint) {
      console.warn(`⚠ Unknown endpoint slug in ledger: ${slug}`);
      continue;
    }

    const routing = endpoint.status?.payout_routing;

    if (routing === "dri" || !endpoint.contributor) {
      // Unattributed endpoints: 95% (contributor + dri shares) routes to DRI pool; PC still gets 5%
      if (!payouts.has("dri-pool")) {
        payouts.set("dri-pool", { address: SERVICE_WALLET, sats: 0, slugs: [] });
      }
      const pool = payouts.get("dri-pool");
      pool.sats += stat.split.contributor + stat.split.dri;
      pool.slugs.push(slug);
    } else {
      if (!payouts.has(endpoint.contributor)) {
        payouts.set(endpoint.contributor, {
          address: endpoint.payout_address,
          sats: 0,
          slugs: [],
        });
      }
      const contrib = payouts.get(endpoint.contributor);
      contrib.sats += stat.split.contributor;
      contrib.slugs.push(slug);

      // DRI share (5%) goes to DRI pool for attributed endpoints
      if (!payouts.has("dri-pool")) {
        payouts.set("dri-pool", { address: SERVICE_WALLET, sats: 0, slugs: [] });
      }
      const pool = payouts.get("dri-pool");
      pool.sats += stat.split.dri;
      if (!pool.slugs.includes(slug)) pool.slugs.push(slug);
    }

    // Player-coach always gets 5%
    if (!payouts.has("player-coach")) {
      payouts.set("player-coach", {
        address: manifest.metadata.addresses.player_coach,
        sats: 0,
        slugs: [],
      });
    }
    const pc = payouts.get("player-coach");
    pc.sats += stat.split.player_coach;
    if (!pc.slugs.includes(slug)) pc.slugs.push(slug);
  }

  // Payout table
  console.log("Payout Table (per recipient):\n");
  console.log("Recipient".padEnd(25) + "Sats".padEnd(12) + "Address".padEnd(45) + "Slugs");
  console.log("-".repeat(120));

  let totalSats = 0;
  for (const [key, payout] of payouts) {
    console.log(
      key.slice(0, 24).padEnd(25) +
      String(payout.sats).padEnd(12) +
      (payout.address || "N/A").padEnd(45) +
      payout.slugs.join(", ")
    );
    totalSats += payout.sats;
  }

  console.log("-".repeat(120));
  console.log(`TOTAL: ${totalSats} sats across ${payouts.size} recipients\n`);

  if (!shouldBroadcast) {
    console.log("📋 Preview mode — no transactions signed or broadcast.");
    console.log("   Re-run with --broadcast to execute.\n");
    process.exit(0);
  }

  // ── Broadcast mode ──────────────────────────────────────────────────────────
  const privateKey = process.env.QV_STX_PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ QV_STX_PRIVATE_KEY env var is required for --broadcast");
    console.error("   export QV_STX_PRIVATE_KEY=<hex-private-key>");
    process.exit(1);
  }

  const { makeContractCall, broadcastTransaction, Pc, PostConditionMode, noneCV, uintCV, principalCV, AnchorMode } =
    await import("@stacks/transactions");

  // Fetch current nonce once; increment locally to avoid collisions across multi-payout runs
  const acctRes = await fetch(`${HIRO_API}/v2/accounts/${SERVICE_WALLET}?proof=0`);
  if (!acctRes.ok) throw new Error(`Nonce fetch failed: ${acctRes.status}`);
  const { nonce: initialNonce } = await acctRes.json();
  let nonce = Number(initialNonce);
  console.log(`\n🔏 Starting nonce: ${nonce}`);
  console.log("🔏 Signing + broadcasting sBTC transfers...\n");

  const results = [];
  for (const [key, payout] of payouts) {
    if (!payout.sats || payout.sats === 0 || !payout.address) continue;

    // Skip self-transfers (DRI pool → SERVICE_WALLET, already there)
    if (payout.address === SERVICE_WALLET) {
      console.log(`  ↷ Skipping self-transfer for ${key} (DRI pool stays in service wallet)`);
      continue;
    }

    console.log(`  → ${key} (${payout.address}): ${payout.sats} sats [nonce ${nonce}]`);

    const tx = await makeContractCall({
      contractAddress: SBTC_CONTRACT_ADDR,
      contractName: SBTC_CONTRACT_NAME,
      functionName: "transfer",
      functionArgs: [
        uintCV(BigInt(payout.sats)),
        principalCV(SERVICE_WALLET),
        principalCV(payout.address),
        noneCV(),
      ],
      senderKey: privateKey,
      network: "mainnet",
      anchorMode: AnchorMode.Any,
      postConditions: [
        Pc.principal(SERVICE_WALLET)
          .willSendEq(BigInt(payout.sats))
          .ft(`${SBTC_CONTRACT_ADDR}.${SBTC_CONTRACT_NAME}`, SBTC_ASSET_NAME),
      ],
      postConditionMode: PostConditionMode.Deny,
      nonce: BigInt(nonce),
      fee: 10000n, // ~0.01 STX gas
    });

    nonce++;

    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });

    if (res.error) {
      console.error(`  ❌ Broadcast failed for ${key}: ${res.error} — ${res.reason}`);
      results.push({ key, address: payout.address, sats: payout.sats, status: "failed", error: res.error });
    } else {
      const txid = typeof res === "string" ? res : res.txid;
      console.log(`  ✓ txid: ${txid}`);
      console.log(`    https://explorer.hiro.so/txid/${txid}?chain=mainnet`);
      results.push({ key, address: payout.address, sats: payout.sats, status: "broadcast", txid });
    }
  }

  console.log("\n── Summary ──");
  const ok = results.filter(r => r.status === "broadcast");
  const fail = results.filter(r => r.status === "failed");
  console.log(`✓ ${ok.length} broadcast, ✗ ${fail.length} failed`);
  if (fail.length > 0) {
    fail.forEach(r => console.log(`  ✗ ${r.key}: ${r.error}`));
    process.exit(1);
  }

  process.exit(0);

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
