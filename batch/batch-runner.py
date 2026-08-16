#!/usr/bin/env python3
"""
career-ops batch runner — standalone orchestrator for Hermes subagent workers
Reads batch-input.tsv, delegates each offer to a Hermes subagent worker,
tracks state in batch-state.tsv for resumability.

This version uses Hermes subagents by default (via delegate_task tool)
instead of claude -p workers.

Usage from Hermes agent:
  1. Run with --dry-run to see pending offers
  2. Run with --plan to output a JSON work plan
  3. Hermes agent reads the work plan and spawns subagents via delegate_task
  4. Run with --collect to gather results from completed subagents
  5. Run with --merge to merge tracker additions
"""

import os
import sys
import csv
import json
import time
import argparse
import subprocess
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
BATCH_DIR = SCRIPT_DIR
INPUT_FILE = BATCH_DIR / "batch-input.tsv"
STATE_FILE = BATCH_DIR / "batch-state.tsv"
PROMPT_FILE = BATCH_DIR / "batch-prompt.md"
PROFILE_FILE = PROJECT_DIR / "config" / "profile.yml"
LOGS_DIR = BATCH_DIR / "logs"
DISCARD_LOG = LOGS_DIR / "discard.log"
TRACKER_DIR = BATCH_DIR / "tracker-additions"
REPORTS_DIR = PROJECT_DIR / "reports"
APPLICATIONS_FILE = PROJECT_DIR / "data" / "applications.md"
LOCK_FILE = BATCH_DIR / "batch-runner.pid"
PAUSE_FILE = BATCH_DIR / "batch-runner.paused"
STATE_LOCK_DIR = BATCH_DIR / ".batch-state.lock"
STATE_LOCK_PID_FILE = STATE_LOCK_DIR / "pid"
STATE_LOCK_TIMEOUT_SECONDS = 30

@dataclass
class Offer:
    id: int
    url: str
    source: str = ""
    notes: str = ""

@dataclass
class OfferState:
    id: int
    url: str
    status: str
    started_at: str
    completed_at: str
    report_num: str
    score: str
    error: str
    retries: int

class Config:
    def __init__(self, parallel: int = 1, dry_run: bool = False, retry_failed: bool = False,
                 resume_paused: bool = False, start_from: int = 0, limit: int = 0,
                 max_retries: int = 2, min_score: float = 0.0, skip_pdf: bool = False,
                 rate_limit_sleep: int = 300, model: str = "", status_only: bool = False,
                 watch: bool = False, plan: bool = False, collect: bool = False,
                 merge: bool = False):
        self.parallel = parallel
        self.dry_run = dry_run
        self.retry_failed = retry_failed
        self.resume_paused = resume_paused
        self.start_from = start_from
        self.limit = limit
        self.max_retries = max_retries
        self.min_score = min_score
        self.skip_pdf = skip_pdf
        self.rate_limit_sleep = rate_limit_sleep
        self.model = model
        self.status_only = status_only
        self.watch = watch
        self.plan = plan
        self.collect = collect
        self.merge = merge

class HermesBatchRunner:
    def __init__(self, config: Config):
        self.config = config
        self.offers: List[Offer] = []
        self.state: Dict[int, OfferState] = {}
        self.offers_by_id: Dict[int, Offer] = {}
        self.batch_paused = False
       
    def load_offers(self) -> List[Offer]:
        """Load pending offers from batch-input.tsv"""
        offers = []
        if not INPUT_FILE.exists():
            print(f"ERROR: {INPUT_FILE} not found. Add offers first.")
            sys.exit(1)
          
        with open(INPUT_FILE, 'r') as f:
            reader = csv.reader(f, delimiter='\t')
            header = next(reader, None)
            for i, row in enumerate(reader):
                if len(row) < 2:
                    continue
                offer_id = int(row[0])
                if self.config.start_from and offer_id < self.config.start_from:
                    continue
                # Don't apply limit here - apply it in get_pending_offers/generate_work_plan
                  
                offer = Offer(
                    id=offer_id,
                    url=row[1],
                    source=row[2] if len(row) > 2 else "",
                    notes=row[3] if len(row) > 3 else ""
                )
                offers.append(offer)
                self.offers_by_id[offer_id] = offer
                self.offers.append(offer)
              
        print(f"Loaded {len(offers)} offers from {INPUT_FILE}")
        return offers
  
    def load_state(self) -> Dict[int, OfferState]:
        """Load batch state from batch-state.tsv"""
        state = {}
        if not STATE_FILE.exists():
            return state
          
        with open(STATE_FILE, 'r') as f:
            reader = csv.reader(f, delimiter='\t')
            header = next(reader, None)
            for row in reader:
                if len(row) < 9 or row[0] == 'id':
                    continue
                try:
                    state[int(row[0])] = OfferState(
                        id=int(row[0]),
                        url=row[1],
                        status=row[2],
                        started_at=row[3],
                        completed_at=row[4],
                        report_num=row[5],
                        score=row[6],
                        error=row[7],
                        retries=int(row[8]) if row[8] else 0
                    )
                except Exception as e:
                    print(f"Warning: Failed to parse state row: {e}")
                    continue
                 
        return state
  
    def save_state(self):
        """Save batch state to batch-state.tsv"""
        with open(STATE_FILE, 'w') as f:
            f.write('id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n')
            for state in sorted(self.state.values(), key=lambda s: s.id):
                f.write(f"{state.id}\t{state.url}\t{state.status}\t{state.started_at}\t"
                       f"{state.completed_at}\t{state.report_num}\t{state.score}\t"
                       f"{state.error}\t{state.retries}\n")
  
    def get_next_report_num(self) -> int:
        """Get next available report number"""
        max_num = 0
        # Check existing reports
        if REPORTS_DIR.exists():
            for f in REPORTS_DIR.glob("*.md"):
                try:
                    num = int(f.stem.split('-')[0])
                    if num > max_num:
                        max_num = num
                except:
                    pass
        # Check state file for assigned report numbers
        for state in self.state.values():
            if state.report_num and state.report_num != '-':
                try:
                    num = int(state.report_num)
                    if num > max_num:
                        max_num = num
                except:
                    pass
        return max_num + 1
  
    def get_pending_offers(self) -> List[Offer]:
        """Get offers that need processing"""
        pending = []
      
        # If resuming paused, get paused offers
        if self.config.resume_paused:
            for offer in self.offers:
                state = self.state.get(offer.id)
                if state and state.status == "paused_rate_limit":
                    pending.append(offer)
            return pending
          
        # If retry failed, get failed offers
        if self.config.retry_failed:
            for offer in self.offers:
                state = self.state.get(offer.id)
                if state and state.status == "failed":
                    pending.append(offer)
            return pending
          
        # Normal: get all offers not in completed/skipped state
        for offer in self.offers:
            state = self.state.get(offer.id)
            if not state or state.status in ("pending", "failed", "processing"):
                pending.append(offer)
              
        # Apply limit
        if self.config.limit and len(pending) > self.config.limit:
            pending = pending[:self.config.limit]
             
        return pending

    def load_profile(self) -> Dict[str, Any]:
        """Load profile configuration"""
        import yaml
        if PROFILE_FILE.exists():
            with open(PROFILE_FILE, 'r') as f:
                return yaml.safe_load(f)
        return {}

    def prepare_worker_prompt(self, offer: Offer, report_num: int, jd_file: str) -> str:
        """Prepare the prompt for the Hermes subagent worker"""
        if not PROMPT_FILE.exists():
            print(f"ERROR: {PROMPT_FILE} not found.")
            sys.exit(1)
          
        with open(PROMPT_FILE, 'r') as f:
            prompt = f.read()
      
        # Replace placeholders
        date = datetime.now().strftime("%Y-%m-%d")
        prompt = prompt.replace("{{URL}}", offer.url)
        prompt = prompt.replace("{{JD_FILE}}", jd_file)
        prompt = prompt.replace("{{REPORT_NUM}}", f"{report_num:03d}")
        prompt = prompt.replace("{{DATE}}", date)
        prompt = prompt.replace("{{ID}}", str(offer.id))
      
        # Inject user-layer personalization
        for context_file in [
            PROJECT_DIR / "modes" / "_profile.md",
            PROJECT_DIR / "config" / "profile.yml",
            PROJECT_DIR / "modes" / "_custom.md"
        ]:
            if context_file.exists():
                with open(context_file, 'r') as f:
                    content = f.read()
                prompt += f"\n\n---\n\n## Runtime personalization: {context_file.relative_to(PROJECT_DIR)}\n\n"
                prompt += "\n".join(f"    {line}" for line in content.splitlines())
                prompt += "\n"
      
        return prompt

    def generate_work_plan(self) -> Dict[str, Any]:
        """Generate a work plan for Hermes subagents"""
        pending = self.get_pending_offers()
      
        if not pending:
            return {"offers": [], "message": "No offers to process"}
      
        # Limit to parallel workers
        if self.config.limit and len(pending) > self.config.limit:
            pending = pending[:self.config.limit]
      
        work_plan = {
            "config": {
                "parallel": self.config.parallel,
                "max_retries": self.config.max_retries,
                "min_score": self.config.min_score,
                "skip_pdf": self.config.skip_pdf,
                "rate_limit_sleep": self.config.rate_limit_sleep
            },
            "offers": []
        }
      
        for offer in pending:
                    report_num = self.get_next_report_num()
         
                    # Download JD content
                    jd_file = LOGS_DIR / f"jd-{report_num:03d}-{offer.id}.txt"
                    LOGS_DIR.mkdir(parents=True, exist_ok=True)
         
                    # Use curl to fetch the JD
                    try:
                        result = subprocess.run(
                            ["curl", "-sL", "--max-time", "30", offer.url],
                            capture_output=True,
                            text=True,
                            timeout=35
                        )
                        jd_content = result.stdout[:50000]  # Limit size
                        with open(jd_file, 'w') as f:
                            f.write(jd_content)
                    except Exception as e:
                        jd_content = f"Failed to fetch JD: {e}"
                        with open(jd_file, 'w') as f:
                            f.write(jd_content)
         
                    # Prepare prompt
                    prompt = self.prepare_worker_prompt(offer, report_num, str(jd_file))
         
                    work_plan["offers"].append({
                        "id": offer.id,
                        "url": offer.url,
                        "source": offer.source,
                        "notes": offer.notes,
                        "report_num": report_num,
                        "jd_file": str(jd_file),
                        "prompt": prompt
                    })
           
                    # Reserve report number in state to prevent collisions
                    self.state[offer.id] = OfferState(
                        id=offer.id,
                        url=offer.url,
                        status="processing",
                        started_at=datetime.utcnow().isoformat() + "Z",
                        completed_at="-",
                        report_num=str(report_num),
                        score="-",
                        error="-",
                        retries=0
                    )
                    self.save_state()
      
        return work_plan

    def collect_results(self) -> Dict[str, Any]:
        """Collect results from completed subagents and update state"""
        results = {"collected": 0, "failed": 0, "paused": 0}
      
        # Read tracker additions to find completed reports - check both locations
        tracker_files = list(TRACKER_DIR.glob("*.tsv")) + list((TRACKER_DIR / "processed").glob("*.tsv"))
      
        for tracker_file in tracker_files:
            try:
                with open(tracker_file, 'r') as f:
                    line = f.read().strip()
                if not line:
                    continue
              
                parts = line.split('\t')
                if len(parts) < 9:
                    continue
              
                report_num = int(parts[0])
                date = parts[1]
                company = parts[2]
                role = parts[3]
                status = parts[4]
                score_str = parts[5]
                pdf_emoji = parts[6]
                report_link = parts[7]
                notes = parts[8] if len(parts) > 8 else ""
              
                # Find the offer ID for this report
                offer_id = None
                for oid, state in self.state.items():
                    if state.report_num == str(report_num):
                        offer_id = oid
                        break
              
                if offer_id is None:
                    # Try to match by company/role in state
                    for oid, state in self.state.items():
                        if state.report_num == str(report_num):
                            offer_id = oid
                            break
              
                if offer_id is not None:
                    # Update state
                    self.state[offer_id].status = "completed"
                    self.state[offer_id].completed_at = datetime.utcnow().isoformat() + "Z"
                    self.state[offer_id].score = score_str.replace("/5", "")
                  
                    # Move tracker file to processed
                    processed_dir = TRACKER_DIR / "processed"
                    processed_dir.mkdir(exist_ok=True)
                    tracker_file.rename(processed_dir / tracker_file.name)
                  
                    results["collected"] += 1
              
            except Exception as e:
                print(f"Warning: Failed to process tracker file {tracker_file}: {e}")
                results["failed"] += 1
      
        self.save_state()
        return results

    def run_status(self):
        """Show batch progress and per-job table"""
        if not STATE_FILE.exists():
            print("No state file found.")
            return
          
        total = completed = failed = pending = skipped = processing = rate_limited = paused = 0
        score_sum = 0
        score_count = 0
      
        with open(STATE_FILE, 'r') as f:
            reader = csv.reader(f, delimiter='\t')
            header = next(reader, None)
            for row in reader:
                if len(row) < 9:
                    continue
                total += 1
                status = row[2]
                score = row[6]
              
                if status == "completed":
                    completed += 1
                    try:
                        score_sum += float(score)
                        score_count += 1
                    except:
                        pass
                elif status == "failed":
                    failed += 1
                elif status == "skipped":
                    skipped += 1
                elif status == "processing":
                    processing += 1
                elif status == "rate_limited":
                    rate_limited += 1
                elif status == "paused_rate_limit":
                    paused += 1
                else:
                    pending += 1
      
        print("=== Batch Progress ===")
        print(f"Total: {total} | Completed: {completed} | Processing: {processing} | "
              f"Failed: {failed} | Pending: {pending} | Skipped: {skipped} | "
              f"Rate Limited: {rate_limited} | Paused: {paused}")
      
        if score_count > 0:
            avg = score_sum / score_count
            print(f"Average score: {avg:.1f}/5 ({score_count} scored)")
      
        print()
        print("=== Per-Job Status ===")
        print(f"{'ID':<4} | {'Status':<17} | {'Report':<6} | {'Score':<5} | {'Target'}")
        print("-" * 80)
      
        with open(STATE_FILE, 'r') as f:
            reader = csv.reader(f, delimiter='\t')
            header = next(reader, None)
            for row in reader:
                if len(row) < 9:
                    continue
                oid, url, status, started, completed, report_num, score, error, retries = row[:9]
                target = url
                if status == "failed" and error and error != "-":
                    target = f"Error: {error[:60]}"
                if len(target) > 50:
                    target = target[:47] + "..."
                print(f"{oid:<4} | {status:<17} | {report_num:<6} | {score:<5} | {target}")

    def run_merge_tracker(self):
        """Run merge-tracker.mjs and verify-pipeline.mjs"""
        print("\n=== Merging tracker additions ===")
        result = subprocess.run(
            ["node", str(PROJECT_DIR / "merge-tracker.mjs")],
            capture_output=True,
            text=True,
            cwd=PROJECT_DIR
        )
        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
      
        print("\n=== Reconciling pipeline.md ===")
        result = subprocess.run(
            ["node", str(PROJECT_DIR / "reconcile-pipeline.mjs")],
            capture_output=True,
            text=True,
            cwd=PROJECT_DIR
        )
        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
      
        print("\n=== Verifying pipeline integrity ===")
        result = subprocess.run(
            ["node", str(PROJECT_DIR / "verify-pipeline.mjs")],
            capture_output=True,
            text=True,
            cwd=PROJECT_DIR
        )
        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)

def run_dry_run(config: Config):
    """Run dry run - just show what would be processed"""
    print("=== career-ops batch runner (Hermes subagents) ===")
    
    runner = HermesBatchRunner(config)
    offers = runner.load_offers()
    
    print(f"\nTotal offers in input: {len(runner.offers)}")
    
    # Load state
    runner.state = runner.load_state()
    
    # Get pending offers
    pending = runner.get_pending_offers()
    
    print(f"Pending offers: {len(pending)}")
    print("\n=== DRY RUN (no processing) ===")
    
    for offer in pending[:20]:
        state = runner.state.get(offer.id)
        status = state.status if state else "none"
        print(f"  #{offer.id}: {offer.source} | {offer.notes[:60]} | status: {status}")
    
    if len(pending) > 20:
        print(f"  ... and {len(pending) - 20} more")
    
    print(f"\nWould process {len(pending)} offers")
    return 0

def run_status(config: Config):
    """Show status and exit"""
    runner = HermesBatchRunner(config)
    runner.run_status()
    return 0

def run_plan(config: Config):
    """Generate and output work plan as JSON"""
    runner = HermesBatchRunner(config)
    runner.load_offers()
    runner.state = runner.load_state()
    work_plan = runner.generate_work_plan()
    print(json.dumps(work_plan, indent=2))
    return 0

def run_collect(config: Config):
    """Collect results from completed subagents"""
    runner = HermesBatchRunner(config)
    runner.load_offers()
    runner.state = runner.load_state()
    results = runner.collect_results()
    print(f"Collected {results['collected']} results, {results['failed']} failed, {results['paused']} paused")
    return 0

def run_merge(config: Config):
    """Merge tracker and verify pipeline"""
    runner = HermesBatchRunner(config)
    runner.run_merge_tracker()
    return 0

def main():
    parser = argparse.ArgumentParser(
        description="career-ops batch runner — process job offers via Hermes subagents",
        add_help=False
    )
    parser.add_argument('--parallel', type=int, default=1, help='Number of parallel workers (default: 1)')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be processed, do not execute')
    parser.add_argument('--retry-failed', action='store_true', help='Only retry offers marked as "failed"')
    parser.add_argument('--resume-paused', action='store_true', help='Resume offers paused by session/rate limit')
    parser.add_argument('--start-from', type=int, default=0, help='Start from offer ID N (skip earlier IDs)')
    parser.add_argument('--limit', type=int, default=0, help='Max number of offers to process in this run')
    parser.add_argument('--max-retries', type=int, default=2, help='Max retry attempts per offer (default: 2)')
    parser.add_argument('--min-score', type=float, default=0.0, help='Skip PDF/tracker for offers scoring below N (default: 0 = off)')
    parser.add_argument('--skip-pdf', action='store_true', help='Skip PDF generation entirely')
    parser.add_argument('--rate-limit-sleep', type=int, default=300, help='Seconds to wait before retrying a rate-limited worker (default: 300)')
    parser.add_argument('--model', type=str, help='Override the tier-resolved model')
    parser.add_argument('--status', action='store_true', help='Show batch progress and a per-job table, then exit')
    parser.add_argument('--watch', action='store_true', help='Live-refresh progress until run completes')
    parser.add_argument('--plan', action='store_true', help='Generate work plan JSON for Hermes subagents')
    parser.add_argument('--collect', action='store_true', help='Collect results from completed subagents')
    parser.add_argument('--merge', action='store_true', help='Merge tracker additions and verify pipeline')
    parser.add_argument('-h', '--help', action='help', help='Show this help message and exit')
    
    args = parser.parse_args()
    
    config = Config(
        parallel=args.parallel,
        dry_run=args.dry_run,
        retry_failed=args.retry_failed,
        resume_paused=args.resume_paused,
        start_from=args.start_from,
        limit=args.limit,
        max_retries=args.max_retries,
        min_score=args.min_score,
        skip_pdf=args.skip_pdf,
        rate_limit_sleep=args.rate_limit_sleep,
        model=args.model,
        status_only=args.status,
        watch=args.watch,
        plan=args.plan,
        collect=args.collect,
        merge=args.merge
    )
    
    if args.dry_run:
        return run_dry_run(config)
    
    if args.status:
        return run_status(config)
    
    if args.watch:
        import time
        while True:
            os.system('clear')
            run_status(config)
            time.sleep(2)
    
    if args.plan:
        return run_plan(config)
    
    if args.collect:
        return run_collect(config)
    
    if args.merge:
        return run_merge(config)
    
    # Default: show help
    parser.print_help()
    return 0

if __name__ == "__main__":
    sys.exit(main())