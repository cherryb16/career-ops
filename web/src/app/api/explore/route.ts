import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { readExploreCache, writeBackgroundStatus, readBackgroundStatus } from "@/lib/cache-helpers";
import { parseExplorePatch, DEFAULT_FILTERS, type DiscoveredOffer, type ScanEvent } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: Return cached explore results instantly
export async function GET(req: NextRequest) {
  const cache = readExploreCache();
  const status = readBackgroundStatus();

  if (!cache) {
    return NextResponse.json(
      { offers: [], count: 0, cached: false, message: "No cached results yet. Run a scan first." },
      { headers: { "Cache-Control": "no-cache" } }
    );
  }

  // Apply current filters to cached offers (client can also filter)
  const url = new URL(req.url);
  const positive = url.searchParams.get("q")?.split(",").filter(Boolean) || [];
  const ats = url.searchParams.get("ats")?.split(",").filter(Boolean) || [];
  const sinceDays = Number(url.searchParams.get("since")) || 7;

  let offers = cache.offers;
  if (positive.length) {
    offers = offers.filter((o) => positive.some((k) => o.title.toLowerCase().includes(k.toLowerCase())));
  }
  if (ats.length) {
    offers = offers.filter((o) => ats.includes(o.ats));
  }
  if (sinceDays) {
    const cutoff = Date.now() - sinceDays * 86_400_000;
    offers = offers.filter((o) => o.postedAt && Date.parse(o.postedAt) >= cutoff);
  }

  return NextResponse.json(
    {
      offers,
      count: offers.length,
      cached: true,
      generatedAt: cache.generatedAt,
      summary: cache.summary,
      backgroundStatus: status?.scan || null,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    }
  );
}

// POST: Trigger a background scan (writes trigger file for cron to pick up)
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {}

  const filters = parseExplorePatch(body, DEFAULT_FILTERS);

  // Write trigger file for background cron to pick up
  const triggerPath = path.join(careerOpsRoot(), "data", "explore-trigger.json");
  const trigger = {
    requestedAt: new Date().toISOString(),
    filters,
    requestedBy: "web",
  };

  // Atomic write
  const tmp = `${triggerPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trigger, null, 2), "utf8");
  fs.renameSync(tmp, triggerPath);

  // Update background status to "running"
  const status = readBackgroundStatus() || {
    scan: { lastRun: null, lastRunStatus: "running", lastRunOutput: "", nextRun: null, error: null },
    followup: { lastRun: null, lastRunStatus: "success", nextRun: null },
    exploreCache: { generatedAt: null, source: "scan-ats-full" },
  };
  status.scan.lastRunStatus = "running";
  status.scan.lastRun = new Date().toISOString();
  writeBackgroundStatus(status);

  return NextResponse.json({
    ok: true,
    message: "Scan triggered. Background job will pick it up.",
    trigger: trigger.requestedAt,
  });
}