import { NextRequest, NextResponse } from "next/server";
import { readWhatsNewCache, readBackgroundStatus } from "@/lib/cache-helpers";
import { careerOpsRoot, readApplications } from "@/lib/career-ops";
import type { DiscoveredOffer } from "@/lib/explore";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function computeFallback(days: number): Promise<DiscoveredOffer[]> {
  let rows: string[];
  try {
    rows = fs.readFileSync(path.join(careerOpsRoot(), "data", "scan-history.tsv"), "utf8").split("\n");
  } catch {
    return [];
  }

  const evaluated = new Set(readApplications().map((a) => norm(a.company)).filter(Boolean));

  const toOffer = (c: string[]): DiscoveredOffer | null => {
    const [url, firstSeen, portal, title, company, status, location] = c;
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (status && /skipped|expired/i.test(status)) return null;
    if (company && evaluated.has(norm(company))) return null;
    return {
      url,
      company: (company || "").trim(),
      title: (title || "").trim(),
      location: (location || "").trim(),
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(firstSeen || "") ? firstSeen : "",
      ats: (portal || "").replace(/-full$/, "").trim() || "other",
      source: "whats-new",
    };
  };

  const seen = new Set<string>();
  const offers: DiscoveredOffer[] = [];
  let anyDated = false;
  const cutoff = Date.now() - days * 86_400_000;

  for (let i = rows.length - 1; i >= 1 && offers.length < 24; i--) {
    const c = rows[i].split("\t");
    const t = Date.parse(c[1] || "");
    if (Number.isFinite(t)) anyDated = true;
    if (!Number.isFinite(t) || t < cutoff) continue;
    const o = toOffer(c);
    if (!o || seen.has(o.url)) continue;
    seen.add(o.url);
    offers.push(o);
  }

  if (offers.length === 0 && !anyDated) {
    for (let i = rows.length - 1; i >= 1 && offers.length < 12; i--) {
      const o = toOffer(rows[i].split("\t"));
      if (!o || seen.has(o.url)) continue;
      seen.add(o.url);
      offers.push(o);
    }
  }
  return offers;
}

export async function GET(req: NextRequest) {
  const cache = readWhatsNewCache();
  const status = readBackgroundStatus();

  const days = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));

  if (!cache) {
    const offers = await computeFallback(days);
    return NextResponse.json(
      { offers, count: offers.length, cached: false, generatedAt: null },
      { headers: { "Cache-Control": "no-cache" } }
    );
  }

  const cutoff = Date.now() - days * 86_400_000;
  const filtered = cache.offers.filter((o) => o.postedAt && Date.parse(o.postedAt) >= cutoff);

  return NextResponse.json(
    {
      offers: filtered,
      count: filtered.length,
      cached: true,
      generatedAt: cache.generatedAt,
      backgroundStatus: status?.scan || null,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    }
  );
}