// Shared types for pre-computed cache files
import type { DiscoveredOffer } from '@/lib/explore';

export interface ExploreCache {
  generatedAt: string; // ISO timestamp
  filters: {
    sinceDays: number;
    ats: string[];
    limitPerAts: number;
  };
  offers: DiscoveredOffer[];
  summary: {
    companiesScanned: number;
    companiesAvailable: number;
    unreachable: number;
    capHit: boolean;
    datasetStatus: Record<string, 'ok' | 'stale' | 'empty'>;
  };
}

export interface WhatsNewCache {
  generatedAt: string;
  days: number;
  offers: DiscoveredOffer[];
}

export interface BackgroundJobStatus {
  scan: {
    lastRun: string | null;
    lastRunStatus: 'success' | 'error' | 'running';
    lastRunOutput: string;
    nextRun: string | null; // cron expression or ISO
    error: string | null;
  };
  followup: {
    lastRun: string | null;
    lastRunStatus: 'success' | 'error' | 'running';
    nextRun: string | null;
  };
  exploreCache: {
    generatedAt: string | null;
    source: 'scan' | 'scan-ats-full';
  };
}