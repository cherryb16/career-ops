import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import type { ExploreCache, WhatsNewCache, BackgroundJobStatus } from "./cache-types";

const CACHE_DIR = path.join(careerOpsRoot(), "data");

function readJson<T>(filename: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, filename), "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filename: string, data: unknown): void {
  const tmp = path.join(CACHE_DIR, `${filename}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, path.join(CACHE_DIR, filename));
}

export function readExploreCache(): ExploreCache | null {
  return readJson<ExploreCache>("explore-cache.json");
}

export function writeExploreCache(data: ExploreCache): void {
  writeJson("explore-cache.json", data);
}

export function readWhatsNewCache(): WhatsNewCache | null {
  return readJson<WhatsNewCache>("whats-new-cache.json");
}

export function writeWhatsNewCache(data: WhatsNewCache): void {
  writeJson("whats-new-cache.json", data);
}

export function readBackgroundStatus(): BackgroundJobStatus | null {
  return readJson<BackgroundJobStatus>("background-jobs.json");
}

export function writeBackgroundStatus(data: BackgroundJobStatus): void {
  writeJson("background-jobs.json", data);
}