#!/usr/bin/env node
// One-time bootstrap: upload all 2,220 .offer files to Netlify Blobs, then
// initialize the shuffled mint queue.
//
// Prereqs:
//   1. cd site && npm install
//   2. Get a Netlify personal access token (starts with `nfp_`):
//        https://app.netlify.com/user/applications -> New access token
//   3. Find your site ID (a UUID like 12345678-1234-1234-...):
//        Netlify dashboard -> your site -> Site configuration -> Site information -> Site ID
//   4. Run (any platform):
//        node scripts/upload_offers.mjs --offers ../offers --token nfp_... --site-id <uuid>
//
//      Or set env vars NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID and omit the flags.
//
// What it does:
//   - Reads every bepe_love_NNNN.offer in the --offers directory
//   - Uploads each to a Blobs store named 'bepe-mint-offers' under key 'offer/<NNNN>'
//   - Builds a shuffled queue of all token numbers
//   - Writes that queue + a counter to a Blobs store named 'bepe-mint-queue'
//
// Idempotent-ish: rerunning will overwrite individual offer blobs (fine, same
// content). It will NOT overwrite the queue if one already exists, to avoid
// resetting a live mint mid-flight. Pass --force-queue to override.

import { getStore } from "@netlify/blobs";
import fs from "node:fs/promises";
import path from "node:path";

// ----- args -----
const args = parseArgs(process.argv.slice(2));
const OFFERS_DIR = args["--offers"] || "../offers";
const FORCE_QUEUE = !!args["--force-queue"];
const DRY_RUN = !!args["--dry-run"];

const token = args["--token"] || process.env.NETLIFY_AUTH_TOKEN;
const siteID = args["--site-id"] || args["--siteId"] || process.env.NETLIFY_SITE_ID;

if (!token || !siteID) {
  console.error("Missing credentials.");
  console.error("Pass --token <nfp_...> and --site-id <uuid>, or set NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID env vars.");
  console.error("");
  console.error("Token (starts with `nfp_`): https://app.netlify.com/user/applications -> New access token");
  console.error("Site ID (a UUID): Netlify dashboard -> your site -> Site configuration -> Site information -> Site ID");
  process.exit(1);
}

if (!/^nfp_/.test(token)) {
  console.warn("Warning: token doesn't start with 'nfp_' — make sure you used the Personal Access Token, not the Site ID.");
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(siteID)) {
  console.warn("Warning: site ID doesn't look like a UUID — make sure you used the Site ID, not the Personal Access Token.");
}

const blobOpts = {
  siteID,
  token,
};

// ----- read offer files -----
const dirAbs = path.resolve(OFFERS_DIR);
console.log(`Reading offers from ${dirAbs}`);
const entries = await fs.readdir(dirAbs);
const offerFiles = entries
  .filter(e => /^bepe_love_(\d{4})\.offer$/i.test(e))
  .sort();

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

// ----- upload offers -----
const offersStore = getStore({ name: "bepe-mint-offers", ...blobOpts });
let uploaded = 0;
const concurrency = 8;
const queue = records.slice();

async function worker() {
  while (queue.length) {
    const r = queue.shift();
    if (!r) return;
    const key = `offer/${pad(r.tokenNum)}`;
    await offersStore.set(key, r.text, {
      metadata: { tokenNum: r.tokenNum, uploadedAt: new Date().toISOString() },
    });
    uploaded += 1;
    if (uploaded % 100 === 0 || uploaded === records.length) {
      console.log(`  uploaded ${uploaded}/${records.length}`);
    }
  }
}
console.log(`Uploading ${records.length} offer blobs (concurrency=${concurrency})...`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log("Done uploading offers.");

// ----- init the queue -----
const queueStore = getStore({ name: "bepe-mint-queue", ...blobOpts });
const existing = await queueStore.get("queue", { type: "json" });
if (existing && !FORCE_QUEUE) {
  console.log(`Queue already exists with ${existing.shuffled?.length ?? 0} entries and counter=${existing.counter ?? 0}.`);
  console.log("Skipping queue init. Pass --force-queue to overwrite.");
} else {
  const tokenNums = records.map(r => r.tokenNum);
  shuffleInPlace(tokenNums);
  await queueStore.setJSON("queue", {
    shuffled: tokenNums,
    counter: 0,
    initializedAt: new Date().toISOString(),
    total: tokenNums.length,
  });
  await queueStore.setJSON("dispensed", { items: [] });
  console.log(`Initialized queue with ${tokenNums.length} entries (shuffled).`);
}

console.log("\nBootstrap complete. The /api/mint/random function can now serve offers.");

// ----- helpers -----
function pad(n) { return String(n).padStart(4, "0"); }

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
