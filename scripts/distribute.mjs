#!/usr/bin/env node
/**
 * Quantum Visualizer Revenue Distribution — Monthly sBTC Payout
 *
 * Reads ledger events from CF KV, calculates per-endpoint splits,
 * and builds sBTC transfer transactions for contributor payout.
 *
 * Usage:
 *   node scripts/distribute.mjs [--preview] [--broadcast]
 *
 * --preview: show payout table without signing (default)
 * --broadcast: sign and broadcast transfers (requires keystore access)
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const MANIFEST_PATH = "./data/contributors.json";
const SERVICE_WALLET = "SP2D26THR4EFBY7PH9JXTG8V2XYM7SZGVTVW1Q572";
const SBTC_ASSET = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const NETWORK = "mainnet";
const PRICE_SATS = 100;

const args = process.argv.slice(2);
const isPreview = !args.includes("--broadcast");
const shouldBroadcast = args.includes("--broadcast");

console.log(`\n📊 Quantum Visualizer Revenue Distribution\n`);
console.log(`Mode: ${isPreview && !shouldBroadcast ? "PREVIEW" : "BROADCAST"}`);
console.log(`Updated: ${new Date().toISOString()}\n`);

try {
  // Load manifest
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  // For now: fetch ledger from a test ledger file or API
  // In production: this would read from CF KV via API
  // For this implementation: we show the structure and output template

  const ledger = [
    // Example: { ts: "2026-06-15T14:23:00Z", slug: "top-urgent", txid: "0x...", payer: "SP...", sats: 100, mode: "sponsored-relay" }
  ];

  // Calculate payouts per endpoint
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

  // Build payout table
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
      // DRI pool — accumulate
      if (!payouts.has("dri-pool")) {
        payouts.set("dri-pool", { address: SERVICE_WALLET, sats: 0, events: [] });
      }
      const pool = payouts.get("dri-pool");
      pool.sats += contributorShare + driShare;
      pool.events.push({ slug, events: stat.events, sats: stat.sats });
    } else {
      // Contributor-attributed
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

    // PC share — goes to configured address
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

  // Output payout table
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

  // Event breakdown
  if (ledger.length > 0) {
    console.log("Event Breakdown:\n");
    for (const [slug, stat] of endpointStats) {
      console.log(`  ${slug}: ${stat.events} events, ${stat.sats} sats`);
    }
  } else {
    console.log("ℹ No ledger events found. (Test ledger is empty.)\n");
  }

  // Signing / broadcast logic
  if (shouldBroadcast && payouts.size > 0) {
    console.log("\n🔏 Signing mode enabled. Building transfer transactions...\n");

    try {
      // In production: import stacks.js and keystore here
      // const { makeSTXTokenTransfer, broadcastTransaction } = await import("@stacks/transactions");
      // const { decrypt } = await import("@stacks/encryption");

      console.log("Building sBTC transfers...");

      const transfers = [];
      for (const [key, payout] of payouts) {
        if (!payout.sats || payout.sats === 0) continue;

        transfers.push({
          recipient: payout.address,
          amount_sats: payout.sats,
          memo: `x402-payout-${new Date().toISOString().split('T')[0]}`,
        });
      }

      console.log(`✓ Built ${transfers.length} transfer transactions\n`);

      // TODO: Implement signing + broadcast
      // 1. Decrypt keystore with password from env or runtime
      // 2. Derive account at service-wallet index
      // 3. Build sBTC transfer per recipient
      // 4. Sign with account private key
      // 5. Broadcast via Stacks RPC
      // 6. Poll Hiro API for tx_status=success
      // 7. Log to ledger after confirmation

      console.log("⚠ Signing + broadcast requires:");
      console.log("  - stacks.js @stacks/transactions installed");
      console.log("  - Keystore password accessible");
      console.log("  - Stacks RPC endpoint reachable\n");

      console.log("Transfers staged for broadcast (not executed):\n");
      for (const tx of transfers) {
        console.log(`  → ${tx.recipient}: ${tx.amount_sats} sats`);
      }
      console.log("");

    } catch (err) {
      console.error(`❌ Broadcast error: ${err.message}`);
      process.exit(1);
    }
  } else if (!shouldBroadcast) {
    console.log("📋 Preview mode — no transactions signed or broadcast.");
    console.log("   Re-run with --broadcast flag to execute transfers.\n");
  }

  process.exit(0);

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
