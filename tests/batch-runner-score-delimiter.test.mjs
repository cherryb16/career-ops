// tests/batch-runner-score-delimiter.test.mjs — how a worker's score reaches
// the tracker.
//
// FORK DIVERGENCE (why this file was rewritten)
//
// Upstream serialises the worker's final JSON into three fields and reads them
// back with `IFS=$'<D>' read -r parsed_status parsed_error parsed_score`. That
// design has a sharp edge: if the delimiter is IFS *whitespace* (tab), bash
// collapses runs of it and drops empty fields, so a successful worker with an
// empty `error` shifts the score out of its variable and EVERY offer records
// "-" — silently, with exit 0 and a real report on disk.
//
// This fork does not use that mechanism at all (`parsed_status` appears zero
// times). It extracts the score directly from the worker log with sed. So the
// delimiter-collapse bug is structurally impossible here, and the old test's
// emitter/reader regexes could never match — it reported a failure against a
// runner that was fine.
//
// WHAT STILL MATTERS is the outcome the old test protected: a successful worker
// must record its REAL score, never "-". The extractor is pulled out of
// batch-runner.sh and run against realistic logs so the two cannot drift.
import { pass, fail, getBash, ROOT } from "./helpers.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SRC = readFileSync(join(ROOT, "batch/batch-runner.sh"), "utf-8").replace(
  /\r\n/g,
  "\n",
);

console.log("\nbatch-runner.sh — worker score extraction");

// ── static ──────────────────────────────────────────────────────────────────

// Document the divergence as an assertion: if someone later ports upstream's
// delimiter split into this fork, the whitespace-collapse bug comes with it and
// this test must be revisited rather than silently passing.
if (!/parsed_status/.test(SRC)) {
  pass(
    "no IFS-delimited payload split present, so empty fields cannot collapse the score",
  );
} else {
  fail(
    "an upstream-style delimiter split appeared — re-check the IFS-whitespace bug (empty error field eats the score)",
  );
}

const extractorLine = (() => {
  const m = SRC.match(/^\s*score_match=\$\((.*)\)$/m);
  return m ? m[1] : null;
})();

if (extractorLine) {
  pass("found the score extractor");
} else {
  fail("could not find the score_match extractor — this test needs updating");
}

const failedDetector =
  /grep -q '"status"\[\[:space:\]\]\*:\[\[:space:\]\]\*"failed"'/.test(SRC) ||
  /"status"\[\[:space:\]\]\*:\[\[:space:\]\]\*"failed"/.test(SRC);
if (failedDetector) {
  pass(
    'a worker-reported "status":"failed" is detected before any score is trusted',
  );
} else {
  fail(
    "no worker-reported-failure detection — a refusing worker would be recorded completed",
  );
}

// ── behavioural: run the real extractor against realistic logs ──────────────

if (extractorLine) {
  const work = mkdtempSync(join(tmpdir(), "co-score-"));
  try {
    const scriptPath = join(work, "extract.sh");
    // Mirrors process_offer: extract, then fall back to "-" when nothing matched.
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'log_file="$1"',
        'score="-"',
        'score_match=""',
        `score_match=$(${extractorLine})`,
        'if [[ -n "$score_match" ]]; then score="$score_match"; fi',
        'printf "%s\\n" "$score"',
      ].join("\n"),
    );

    const extract = (log) => {
      const f = join(work, "worker.log");
      writeFileSync(f, log);
      return execFileSync(getBash(), [scriptPath, f], {
        encoding: "utf-8",
        timeout: 30000,
      }).trim();
    };

    const FINAL_JSON = (score, err = "null") =>
      `{"status":"completed","id":"12","report_num":"042","company":"Acme",` +
      `"role":"Analyst","score":${score},"legitimacy":"High Confidence",` +
      `"pdf":null,"report":"reports/042-acme.md","error":${err}}`;

    const cases = [
      {
        label: 'a successful worker records its real score, not "-"',
        log: `Reading cv.md...\nWriting report...\n\`\`\`json\n${FINAL_JSON("3.4")}\n\`\`\`\n`,
        expect: "3.4",
      },
      {
        label: "an empty/null error field does not swallow the score",
        log: `${FINAL_JSON("2.1", "null")}\n`,
        expect: "2.1",
      },
      {
        label: "a two-decimal score survives intact",
        log: `${FINAL_JSON("4.25")}\n`,
        expect: "4.25",
      },
      {
        label: "an integer score is extracted",
        log: `${FINAL_JSON("5")}\n`,
        expect: "5",
      },
      {
        label: "extra whitespace after the colon is tolerated",
        log: '{"status":"completed","score":   3.9 }\n',
        expect: "3.9",
      },
      {
        label: 'a log with no score at all falls back to "-"',
        log: "The worker crashed before emitting JSON.\n",
        expect: "-",
      },
      {
        // The prompt template ships `"score": {score_num}` as a placeholder.
        // It must not be mistaken for a real score.
        label: "the prompt template placeholder is not read as a score",
        log:
          'Template says "score": {score_num} and I will fill it in.\n' +
          `\`\`\`json\n${FINAL_JSON("3.0")}\n\`\`\`\n`,
        expect: "3.0",
      },
      {
        // THE CONTRACT: batch-prompt.md Step 6 requires the final JSON payload
        // to be the worker's last output. If narration earlier in the log
        // mentions a score, the FINAL payload is still the authoritative one.
        label: "the FINAL json wins when narration mentions an earlier score",
        log:
          'Draft thinking: maybe "score": 1.2 for this one?\n' +
          "On reflection the comp band is stronger.\n" +
          `\`\`\`json\n${FINAL_JSON("4.2")}\n\`\`\`\n`,
        expect: "4.2",
      },
    ];

    for (const c of cases) {
      const got = extract(c.log);
      if (got === c.expect) {
        pass(`${c.label} → ${got}`);
      } else {
        fail(`${c.label}: expected ${c.expect}, got ${got}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
