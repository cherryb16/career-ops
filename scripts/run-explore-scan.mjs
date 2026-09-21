#!/usr/bin/env node
/**
 * Background explore scan runner.
 * Reads trigger from data/explore-trigger.json, runs scan-ats-full --json,
 * writes results to data/explore-cache.json and updates data/background-jobs.json.
 * Designed to run via cron/launchd (see AUTOMATION.md).
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data");
const TRIGGER_FILE = path.join(DATA_DIR, "explore-trigger.json");
const CACHE_FILE = path.join(DATA_DIR, "explore-cache.json");
const STATUS_FILE = path.join(DATA_DIR, "background-jobs.json");
const SCAN_SCRIPT = path.join(REPO_ROOT, "scan-ats-full.mjs");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function updateStatus(partial) {
  const current = readJson(STATUS_FILE, {});
  writeJson(STATUS_FILE, { ...current, scan: { ...current.scan, ...partial } });
}

function updateExploreCacheStatus(generatedAt) {
  const current = readJson(STATUS_FILE, {});
  writeJson(STATUS_FILE, {
    ...current,
    exploreCache: { ...current.exploreCache, generatedAt, source: "scan-ats-full" },
  });
}

/** The scanner emits `source: "workday-full"`; the web's DiscoveredOffer type
 *  also needs a bare `ats` ("workday") for the /api/explore ats filter. */
function normalizeOffer(o) {
  return { ...o, ats: o.ats || String(o.source || "").replace(/-full$/, "") || "other" };
}

async function main() {
  const trigger = readJson(TRIGGER_FILE);
  if (!trigger) {
    console.log("No trigger file — nothing to do");
    return;
  }

  console.log(`[${new Date().toISOString()}] Starting explore scan...`);
  updateStatus({ lastRunStatus: "running", lastRun: new Date().toISOString(), error: null });

  const { sinceDays = 7, ats = ["greenhouse", "lever", "ashby", "workday"], limitPerAts = 150 } = trigger.filters || {};

  const args = [
    SCAN_SCRIPT,
    "--dry-run",
    "--json",
    "--since",
    String(sinceDays),
    "--ats",
    ats.join(","),
    "--limit",
    String(limitPerAts),
  ];

  const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  if (exitCode !== 0) {
    const error = stderr || `Exit code ${exitCode}`;
    console.error("Scan failed:", error);
    updateStatus({ lastRunStatus: "error", lastRunOutput: stderr, error });
    return;
  }

  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch (e) {
    console.error("Failed to parse JSON output:", e.message);
    updateStatus({ lastRunStatus: "error", lastRunOutput: stdout, error: "Invalid JSON from scanner" });
    return;
  }

  // Write explore cache.
  // Guard: a scan that returns nothing (narrow filters, ATS outage, a sweep that
  // hit mostly unreachable boards) must not clobber a populated cache — the web
  // is read-only and would show an empty Explore page until the next good run.
  const newOffers = (result.offers || []).map(normalizeOffer);
  const previous = readJson(CACHE_FILE);
  if (newOffers.length === 0 && previous?.offers?.length) {
    const msg = `Scan returned 0 offers; keeping previous cache of ${previous.offers.length} (generated ${previous.generatedAt})`;
    console.log(msg);
    updateStatus({ lastRunStatus: "success", lastRunOutput: `0 offers — previous cache retained`, error: null });
    try {
      fs.unlinkSync(TRIGGER_FILE);
    } catch {}
    return;
  }

  const cache = {
    generatedAt: new Date().toISOString(),
    filters: { sinceDays, ats, limitPerAts },
    offers: newOffers,
    summary: {
      companiesScanned: result.companiesScanned || 0,
      companiesAvailable: result.companiesAvailable || 0,
      unreachable: result.unreachableBoards || 0,
      capHit: result.capHit || false,
      datasetStatus: result.datasetStatus || {},
    },
  };
  writeJson(CACHE_FILE, cache);
  updateExploreCacheStatus(cache.generatedAt);

  // Write whats-new cache (reuse scan-history logic)
  const historyPath = path.join(DATA_DIR, "scan-history.tsv");
  let whatsNewOffers = [];
  if (fs.existsSync(historyPath)) {
    const rows = fs.readFileSync(historyPath, "utf8").split("\n");
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const evaluated = new Set(); // could load from applications.md
    const cutoff = Date.now() - 7 * 86_400_000;
    for (let i = rows.length - 1; i >= 1 && whatsNewOffers.length < 24; i--) {
      const c = rows[i].split("\t");
      const t = Date.parse(c[1] || "");
      if (!Number.isFinite(t) || t < cutoff) continue;
      const [url, firstSeen, portal, title, company, status, location] = c;
      if (!url || !/^https?:/i.test(url)) continue;
      if (status && /skipped|expired/i.test(status)) continue;
      if (company && evaluated.has(norm(company))) continue;
      whatsNewOffers.push({
        url,
        company: (company || "").trim(),
        title: (title || "").trim(),
        location: (location || "").trim(),
        postedAt: /^\d{4}-\d{2}-\d{2}$/.test(firstSeen || "") ? firstSeen : "",
        ats: (portal || "").replace(/-full$/, "").trim() || "other",
        source: "whats-new",
      });
    }
  }
  writeJson(path.join(DATA_DIR, "whats-new-cache.json"), {
    generatedAt: new Date().toISOString(),
    days: 7,
    offers: whatsNewOffers,
  });

  // Clean up trigger
  try {
    fs.unlinkSync(TRIGGER_FILE);
  } catch {}

  updateStatus({ lastRunStatus: "success", lastRunOutput: `${cache.offers.length} offers`, error: null });
  console.log(`[${new Date().toISOString()}] Scan complete: ${cache.offers.length} offers`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  updateStatus({ lastRunStatus: "error", lastRunOutput: String(err), error: String(err) });
  process.exit(1);
});