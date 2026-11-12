import { NextResponse } from "next/server";
import { readBackgroundStatus } from "@/lib/cache-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = readBackgroundStatus();
  return NextResponse.json(status || {
    scan: { lastRun: null, lastRunStatus: "success", lastRunOutput: "", nextRun: null, error: null },
    followup: { lastRun: null, lastRunStatus: "success", nextRun: null },
    exploreCache: { generatedAt: null, source: "scan-ats-full" },
  });
}