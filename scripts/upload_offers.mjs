#!/usr/bin/env node
// One-time bootstrap: upload all 2,220 .offer files to Netlify Blobs and
// initialize the shuffled mint queue.
//
// This script POSTs the offers to the /api/admin/bootstrap function on the
// live site (which then writes to Blobs from inside Netlify's runtime where
// auth always works). This is more reliable than calling the Blobs SDK
// directly with a personal access token, because not every PAT has Blobs
// write scope.
//
// Prereqs:
//   1. Latest commit deployed to Netlify (so admin-bootstrap function exists).
//   2. In Netlify dashboard: Site -> Environment variables -> add
//        MINT_BOOTSTRAP_SECRET = <some long random string>
//      Then trigger a redeploy (env var changes require it).
//   3. cd site && npm install
//
// Run:
//   node scripts/upload_offers.mjs \
//     --offers ../offers \
//     --site-url https://bepelove.netlify.app \
//     --secret <the-secret-you-set>
//
// Idempotent-ish: rerunning will overwrite individual offer blobs (fine).
// The queue is only initialized once. Pass --force to overwrite.

import fs from "node:fs/promises";
import path from "node:path";

// ----- args -----
const args = parseArgs(process.argv.slice(2));
const OFFERS_DIR = args["--offers"] || "../offers";
const SITE_URL = (args["--site-url"] || args["--url"] || "").replace(/\/$/, "");
const SECRET = args["--secret"] || process.env.MINT_BOOTSTRAP_SECRET;
const FORCE = !!args["--force"] || !!args["--force-queue"];
const DRY_RUN = !!args["--dry-run"];
const STATUS_ONLY = !!args["--status"];

const BATCH_SIZE = 50;          // offers per upload-batch POST (~120 KB each)
const BATCH_CONCURRENCY = 4;    // parallel batches in flight

if (!SITE_URL) {
  console.error("Missing --site-url. Example: --site-url https://bepelove.netlify.app");
  process.exit(1);
}
if (!/^https:\/\//.test(SITE_URL)) {
  console.error(`--site-url must start with https:// (got: ${SITE_URL})`);
  process.exit(1);
}
if (!SECRET) {
  console.error("Missing --secret. Pass the same value you set as MINT_BOOTSTRAP_SECRET in Netlify env vars.");
  console.error("(Or set MINT_BOOTSTRAP_SECRET locally as an env var.)");
  process.exit(1);
}

const ENDPOINT = `${SITE_URL}/api/admin/bootstrap`;

// ----- status-only mode -----
if (STATUS_ONLY) {
  const r = await postAdmin({ action: "status" });
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

// ----- read offer files -----
const dirAbs = path.resolve(OFFERS_DIR);
console.log(`Reading offers from ${dirAbs}`);
const entries = await fs.readdir(dirAbs);
const offerFiles = entries.filter(e => /^bepe_love_(\d{4})\.offer$/i.test(e)).sort();

if (offerFiles.length === 0) {
  console.error("No offer files found. Expected filenames like bepe_love_0002.offer");
  process.exit(1);
}

console.log(`Found ${offerFiles.length} offer files.`);
const records = [];
for (const f of offerFiles) {
  const m = f.match(/^bepe_love_(\d{4})\.offer$/i);
  const tokenNum = parseInt(m[1], 10);
  const text = (await fs.readFile(path.join(dirAbs, f), "utf-8")).trim();
  if (!text.startsWith("offer1")) {
    console.warn(`  ! ${f} doesn't start with 'offer1' — skipping`);
    continue;
  }
  records.push({ tokenNum, text });
}
console.log(`Parsed ${records.length} valid offers.`);

if (DRY_RUN) {
  console.log("Dry run — would upload", records.length, "offers and initialize queue.");
  process.exit(0);
}

// ----- pre-flight ping -----
console.log(`Endpoint: ${ENDPOINT}`);
const ping = await postAdmin({ action: "status" }).catch((err) => ({ _err: err }));
if (ping._err || ping.error) {
  console.error("Pre-flight check failed:", ping._err?.message || ping.error || JSON.stringify(ping));
  if (ping.error === "secret_not_configured") {
    console.error("\nFix: in Netlify dashboard, add env var MINT_BOOTSTRAP_SECRET, then trigger a redeploy.");
  }
  if (ping.error === "unauthorized") {
    console.error("\nFix: --secret value doesn't match MINT_BOOTSTRAP_SECRET in Netlify env vars.");
  }
  process.exit(1);
}
console.log(`Pre-flight OK. Queue initialized: ${ping.initialized}, total: ${ping.total}, counter: ${ping.counter}`);

if (ping.initialized && !FORCE) {
  console.log("\nQueue already initialized. Pass --force to re-upload offers and reset queue.");
  console.log("Status check above shows current state. Nothing to do.");
  process.exit(0);
}

// ----- upload offers in batches (parallel) -----
const batches = [];
for (let i = 0; i < records.length; i += BATCH_SIZE) {
  batches.push(records.slice(i, i + BATCH_SIZE));
}
console.log(`Uploading ${records.length} offers in ${batches.length} batches of ~${BATCH_SIZE} (concurrency=${BATCH_CONCURRENCY})...`);

let totalUploaded = 0;
let nextBatchIdx = 0;

async function batchWorker() {
  while (true) {
    const idx = nextBatchIdx++;
    if (idx >= batches.length) return;
    const batch = batches[idx];
    let attempt = 0;
    let success = false;
    while (!success) {
      try {
        const r = await postAdmin({ action: "upload-batch", offers: batch });
        if (r.error) throw new Error(r.error + (r.detail ? ": " + r.detail : ""));
        totalUploaded += r.uploaded || 0;
        if (idx === 0 || (idx + 1) % 5 === 0 || idx === batches.length - 1) {
          console.log(`  batch ${idx + 1}/${batches.length} done · ${totalUploaded} offers uploaded so far`);
        }
        success = true;
      } catch (err) {
        attempt++;
        if (attempt >= 3) { throw err; }
        const wait = 1000 * Math.pow(2, attempt);
        console.warn(`  batch ${idx + 1} attempt ${attempt} failed (${err.message}); retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    // ...continue grabbing more batches via the outer while loop
  }
}

await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, () => batchWorker()));
console.log(`Done uploading. Total: ${totalUploaded} offers.`);

if (totalUploaded < records.length) {
  console.error(`\n  ⚠ Only ${totalUploaded}/${records.length} offers were uploaded.`);
  console.error(`  This will leave gaps in the dispenser. Investigate before initializing the queue.`);
  console.error(`  Re-run with --force after fixing the underlying issue.`);
  process.exit(2);
}

// ----- init queue -----
const tokenNumbers = records.map(r => r.tokenNum);
console.log(`Initializing shuffled queue with ${tokenNumbers.length} entries...`);
const initRes = await postAdmin({ action: "init-queue", tokenNumbers, force: FORCE });
if (initRes.error) {
  console.error("Queue init failed:", initRes.error);
  process.exit(1);
}
if (!initRes.ok) {
  console.warn("Queue not (re)initialized:", initRes.reason);
  console.warn("Pass --force to overwrite an existing queue.");
} else {
  console.log(`Queue initialized with ${initRes.initialized} entries.`);
}

console.log("\nBootstrap complete. /api/mint/random can now serve offers.");
console.log(`Live status: ${SITE_URL}/api/mint/status`);

// ----- helpers -----
async function postAdmin(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, ...body }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: "non_json_response", status: res.status, body: text.slice(0, 500) }; }
  return json;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[a] = next; i++; }
    else out[a] = true;
  }
  return out;
}
