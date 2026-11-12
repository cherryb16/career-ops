// tests/batch-runner-cli-dispatch.test.mjs — the multi-CLI worker dispatch.
//
// FORK DIVERGENCE (why this file was rewritten)
//
// Upstream builds the worker command in `model_args` and supports
// claude/opencode/gemini/qwen. This checkout supports a different CLI set —
// agy, agy-google, agy-other, claude, codex, hermes — and builds the command
// in `worker_args`. The previous version of this test grepped for upstream's
// `model_args` and for the literal string "Unknown --cli", so it reported three
// failures against a runner that was in fact behaving correctly.
//
// THE BUG CLASS STILL WORTH PINNING
//
// Under `set -u`, bash 3.2 (the /bin/bash shipped with macOS) treats
// "${arr[@]}" on an EMPTY array as an unbound variable and aborts. Upstream hit
// this when `model_args` was declared empty and only filled if --model was
// passed, so `--cli opencode` with no --model killed every worker. This fork is
// safe for a different reason: every branch of the dispatch case assigns
// worker_args, so it is never empty at expansion time. That property is load
// bearing, and it is what the static checks below assert.
//
// The unknown-CLI check is asserted BEHAVIOURALLY (run the script, inspect the
// exit code) rather than by grepping for one particular error string — the
// wording is not the contract, the rejection is.
import { pass, fail, ROOT } from "./helpers.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNNER = join(ROOT, "batch/batch-runner.sh");
const SRC = readFileSync(RUNNER, "utf-8").replace(/\r\n/g, "\n");

console.log(
  "\nbatch-runner.sh — multi-CLI worker dispatch (fork: agy/claude/codex/hermes)",
);

// ── static: the dispatch block ──────────────────────────────────────────────

const dispatchBlock = (() => {
  const m = SRC.match(
    /  local -a worker_args=\(\)\n  case "\$CLI" in\n[\s\S]*?\n  esac\n/,
  );
  return m ? m[0] : null;
})();

if (dispatchBlock) {
  pass('found the dispatch block (worker_args + case "$CLI")');
} else {
  fail(
    "could not find the worker_args dispatch block — this test needs updating",
  );
}

// Every CLI the runner advertises must have a dispatch branch, or selecting it
// silently falls through to the claude catch-all and runs the wrong binary.
const SUPPORTED = [
  "agy",
  "agy-google",
  "agy-other",
  "claude",
  "codex",
  "hermes",
];
if (dispatchBlock) {
  const missing = SUPPORTED.filter((c) => {
    const inBranch = new RegExp(
      `(^|\\s|\\|)${c.replace(/-/g, "\\-")}(\\||\\))`,
      "m",
    );
    return !inBranch.test(dispatchBlock);
  });
  if (missing.length === 0) {
    pass(`every supported CLI has a dispatch branch (${SUPPORTED.join(", ")})`);
  } else {
    fail(
      `CLIs with no dispatch branch: ${missing.join(", ")} — they would fall through to the catch-all`,
    );
  }
}

// The bash 3.2 / set -u guard. Either every branch fills worker_args, or the
// expansion uses the ${arr[@]+"${arr[@]}"} idiom. One of the two must hold.
if (dispatchBlock) {
  const branchBodies = dispatchBlock.split(/\n    (?=[a-z*])/).slice(1);
  const emptyBranches = branchBodies.filter(
    (b) => !/worker_args[+]?=\(/.test(b),
  );
  const guardedExpansion =
    /\$\{worker_args\[@\]\+"\$\{worker_args\[@\]\}"\}/.test(SRC);
  if (emptyBranches.length === 0 || guardedExpansion) {
    pass(
      "worker_args is always populated before expansion (safe on bash 3.2 under set -u)",
    );
  } else {
    fail(
      `${emptyBranches.length} dispatch branch(es) may leave worker_args empty and are expanded unguarded — bash 3.2 aborts with "unbound variable"`,
    );
  }
}

// The launch site must cover the same CLI set as the arg-building site, or a
// CLI gets args built and then never invoked.
const launchBlock = (() => {
  const m = SRC.match(
    /    case "\$CLI" in\n      hermes\)[\s\S]*?\n    esac\n/,
  );
  return m ? m[0] : null;
})();

if (launchBlock) {
  const missing = SUPPORTED.filter(
    (c) =>
      !new RegExp(`(^|\\s|\\|)${c.replace(/-/g, "\\-")}(\\||\\))`, "m").test(
        launchBlock,
      ),
  );
  if (missing.length === 0) {
    pass("the launch dispatch covers the same CLI set as the arg builder");
  } else {
    fail(`CLIs built but never launched: ${missing.join(", ")}`);
  }
} else {
  fail("could not find the worker launch dispatch");
}

// ── behavioural: an unsupported --cli is refused ────────────────────────────
// Asserted by running the script, not by matching an error string. Upstream
// says "Unknown --cli", this fork says "Unsupported --cli" and additionally
// lists the valid values; both are correct, so the wording is not the contract.

const run = (args) => {
  try {
    const out = execFileSync("bash", [RUNNER, ...args], {
      encoding: "utf-8",
      timeout: 60000,
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

{
  const r = run(["--cli", "bogus", "--dry-run"]);
  const namesSupported = SUPPORTED.every((c) => r.out.includes(c));
  if (r.code !== 0 && /cli/i.test(r.out) && namesSupported) {
    pass(
      "an unsupported --cli exits non-zero and lists the CLIs that are supported",
    );
  } else if (r.code !== 0) {
    pass(
      "an unsupported --cli exits non-zero (error text does not enumerate the valid values)",
    );
  } else {
    fail(
      `an unsupported --cli was accepted: code=${r.code} out=${r.out.trim().slice(0, 160)}`,
    );
  }
}

// Positive control: without it, the check above would also "pass" on a runner
// that rejected every CLI, including the valid ones.
{
  const r = run(["--help"]);
  if (r.code === 0 && /--cli NAME/.test(r.out)) {
    pass(
      "--help still succeeds and documents --cli (the rejection is selective)",
    );
  } else {
    fail(
      `--help did not succeed: code=${r.code} out=${r.out.trim().slice(0, 160)}`,
    );
  }
}
