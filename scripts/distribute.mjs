#!/usr/bin/env node
/**
 * Quantum Visualizer Revenue Distribution — Monthly sBTC Payout
 *
 * Reads ledger events from CF KV, calculates per-endpoint splits,
 * and broadcasts sBTC transfer transactions for contributor payout.
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
 */

import { readFileSync } from "fs";

const MANIFEST_PATH = "./data/contributors.json";
const SERVICE_WALLET = "SP2D26THR4EFBY7PH9JXTG8V2XYM7SZGVTVW1Q572";
const SBTC_CONTRACT_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_NAME = "sbtc-token";
const HIRO_API = "https://api.hiro.so";
const PRICE_SATS = 100;

const args = process.argv.slice(2);
const shouldBroadcast = args.includes("--broadcast");

console.log(`\n📊 Quantum Visualizer Revenue Distribution\n`);
console.log(`Mode: ${shouldBroadcast ? "BROADCAST" : "PREVIEW"}`);
console.log(`Updated: ${new Date().toISOString()}\n`);

try {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  // Fetch ledger events from CF KV via the free /api/world/revenue/contributors endpoint
  // In production: replace with direct KV read or authenticated CF API call
  const ledger = [
    // Example: { ts: "2026-06-15T14:23:00Z", slug: "top-urgent", txid: "0x...", payer: "SP...", sats: 100 }
  ];

  const payouts = new Map();
  const endpointStats = new Map();

  for (const event of ledger) {
    if (!endpointStats.has(event.slug)) {
      endpointStats.set(event.slug, { events: 0, sats: 0 });
    }
    const stat = endpointStats.get(event.slug);
    stat.events += 1;
    stat.sats += event.sats || PRICE_SATS;
  }

  for (const [slug, stat] of endpointStats) {
    const endpoint = manifest.endpoints[slug];
    if (!endpoint) {
      console.warn(`⚠ Unknown endpoint slug: ${slug}`);
      continue;
    }

    const contributorShare = Math.floor((stat.sats * 90) / 100);
    const pcShare = Math.floor((stat.sats * 5) / 100);
    const driShare = stat.sats - contributorShare - pcShare;
    const routing = endpoint.status.payout_routing;

    if (routing === "dri" || !endpoint.contributor) {
      if (!payouts.has("dri-pool")) {
        payouts.set("dri-pool", { address: SERVICE_WALLET, sats: 0, events: [] });
      }
      const pool = payouts.get("dri-pool");
      pool.sats += contributorShare + driShare;
      pool.events.push({ slug, events: stat.events, sats: stat.sats });
    } else {
      if (!payouts.has(endpoint.contributor)) {
        payouts.set(endpoint.contributor, {
          address: endpoint.payout_address,
          sats: 0,
          events: [],
        });
      }
      const contrib = payouts.get(endpoint.contributor);
      contrib.sats += contributorShare;
      contrib.events.push({ slug, events: stat.events, sats: stat.sats, share: "90%" });
    }

    if (!payouts.has("player-coach")) {
      payouts.set("player-coach", {
        address: manifest.metadata.addresses.player_coach,
        sats: 0,
        events: [],
      });
    }
    const pc = payouts.get("player-coach");
    pc.sats += pcShare;
    pc.events.push({ slug, events: stat.events, sats: stat.sats, share: "5%" });
  }

  // Payout table
  console.log("Payout Table (per recipient):\n");
  console.log("Recipient".padEnd(25) + "Sats".padEnd(12) + "Events".padEnd(8) + "Address");
  console.log("-".repeat(90));

  let totalSats = 0;
  for (const [key, payout] of payouts) {
    console.log(
      key.slice(0, 24).padEnd(25) +
      String(payout.sats).padEnd(12) +
      String(payout.events.length).padEnd(8) +
      (payout.address || "N/A")
    );
    totalSats += payout.sats;
  }

  console.log("-".repeat(90));
  console.log(`TOTAL: ${totalSats} sats across ${payouts.size} recipients\n`);

  if (ledger.length > 0) {
    console.log("Event Breakdown:");
    for (const [slug, stat] of endpointStats) {
      console.log(`  ${slug}: ${stat.events} events, ${stat.sats} sats`);
    }
    console.log("");
  } else {
    console.log("ℹ No ledger events found. (Test ledger is empty.)\n");
  }

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

  console.log("🔏 Signing + broadcasting sBTC transfers...\n");

  const results = [];
  for (const [key, payout] of payouts) {
    if (!payout.sats || payout.sats === 0 || !payout.address) continue;

    // Skip self-transfers (DRI pool → SERVICE_WALLET, already there)
    if (payout.address === SERVICE_WALLET) {
      console.log(`  ↷ Skipping self-transfer for ${key} (DRI pool stays in service wallet)`);
      continue;
    }

    console.log(`  → ${key} (${payout.address}): ${payout.sats} sats`);

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
      postConditionMode: PostConditionMode.Allow,
      fee: 10000n, // ~0.01 STX gas
    });

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
