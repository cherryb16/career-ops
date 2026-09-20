// One-shot repair (2026-08-27): reconcile reports/ <-> pipeline.md <-> applications.md
// after crashed batch runs. See backups/repair-2026-08-27/ for pre-repair copies.
import fs from "fs";

const DRY = process.argv.includes("--dry-run");
const RD = "reports/";

// ---------- parse reports ----------
const files = fs.readdirSync(RD).filter((f) => f.endsWith(".md"));
const meta = {};
const normUrl = (u) => (u || "").trim().replace(/\/+$/, "");
for (const f of files) {
  const t = fs.readFileSync(RD + f, "utf8");
  const url = normUrl((t.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1]);
  const score = (t.match(/\*\*Score:\*\*\s*([\d.]+)/) || [])[1] || null;
  const ms = t.match(/## Machine Summary[\s\S]*?```yaml\n([\s\S]*?)```/);
  const y = ms ? ms[1] : "";
  const g = (k) =>
    (y.match(new RegExp("^" + k + ':\\s*"?([^"\\n]+)"?\\s*$', "m")) || [])[1] ||
    null;
  const hardStop =
    (y.match(/^hard_stops:\n\s+- "?([^"\n]+)"?/m) || [])[1] || null;
  meta[f] = {
    url,
    score,
    mtime: fs.statSync(RD + f).mtimeMs,
    company: g("company"),
    role: g("role"),
    decision: g("final_decision"),
    hardStop,
    num: f.match(/^(\d+)/)[1],
    date: (f.match(/(\d{4}-\d{2}-\d{2})\.md$/) || [])[1],
  };
}
const byUrl = {};
for (const f of files) {
  const u = meta[f].url;
  if (!u || u.includes("REDACTED")) continue;
  (byUrl[u] = byUrl[u] || []).push(f);
}
// archived reports, for processed lines whose eval was superseded into archive/
const byUrlArchive = {};
for (const f of fs
  .readdirSync(RD + "archive")
  .filter((f) => f.endsWith(".md"))) {
  const t = fs.readFileSync(RD + "archive/" + f, "utf8");
  const u = normUrl((t.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1]);
  const s = (t.match(/\*\*Score:\*\*\s*([\d.]+)/) || [])[1] || null;
  if (u && !u.includes("REDACTED") && !byUrlArchive[u])
    byUrlArchive[u] = { f, s, num: f.match(/^(\d+)/)[1] };
}

// ---------- winners & losers ----------
// Archive scope: dup groups touched by the crashed 08-26/08-27 batch (any member >= 2078)
// or carrying a number collision. Older re-eval pairs are left alone.
const winner = {}; // url -> file
const losers = []; // files to archive after merge
for (const [u, group] of Object.entries(byUrl)) {
  const sorted = [...group].sort((a, b) => meta[b].mtime - meta[a].mtime);
  winner[u] = sorted[0];
  if (group.length > 1) {
    const nums = group.map((g) => meta[g].num);
    const inBatch = group.some((g) => parseInt(meta[g].num) >= 2078);
    const collision = new Set(nums).size < nums.length;
    if (inBatch || collision) losers.push(...sorted.slice(1));
  }
}

// Targeted row fixes (tracker row id -> winner report file). Chosen so tier-0 (URL)
// or tier-2 (entry-num + company) matches deterministically in merge-tracker.
const targeted = {
  1585: "2107-delivery-consultant-security-amazon-2026-08-26.md",
  1586: "2108-amazon-2026-08-26.md",
  1587: "2345-amazon-2026-08-27.md",
  1588: "2203-amazon-air-2026-08-27.md",
  1589: "2204-amazon-whole-foods-2026-08-27.md",
  1590: "2158-amazon-solutions-architect-advertising-marketing-2026-08-26.md",
  1595: "2238-amazon-2026-08-27.md",
  1596: "2113-amazon-solutions-architecture-manager-2026-08-26.md",
  1597: "2239-amazon-2026-08-27.md",
  1603: "2121-amazon-2026-08-26.md",
  1605: "2346-amazon-one-medical-2026-08-27.md",
  1606: "2122-amazon-2026-08-26.md",
  1607: "2307-amazon-field-advisor-2026-08-27.md",
};
const rowCompany = {
  // verbatim from tracker rows, so companiesMatch() holds on tier-2
  1585: "Amazon Web Services",
  1586: "Amazon Web Services",
  1587: "Amazon Web Services",
  1588: "Amazon",
  1589: "Amazon",
  1590: "Amazon",
  1595: "Amazon",
  1596: "Amazon Web Services (AWS)",
  1597: "Amazon",
  1603: "Amazon",
  1605: "Amazon One Medical",
  1606: "Amazon",
  1607: "Amazon Web Services, Inc.",
};
const oldReportOfRow = {
  // lost or superseded report file per row (for the note)
  1585: "1585",
  1586: "1586",
  1587: "1587",
  1588: "1588 (file lost)",
  1589: "1589 (file lost)",
  1590: "1590 (file lost)",
  1595: "1595 (file lost)",
  1596: "1596",
  1597: "1597 (file lost)",
  1603: "1603",
  1605: "1605",
  1606: "1606",
  1607: "1607 (file lost)",
};
// Old report files superseded by targeted fixes -> archive after merge
const supersededOld = [
  "1585-amazon-web-services-2026-08-26.md",
  "1586-amazon-web-services-2026-08-26.md",
  "1587-amazon-web-services-2026-08-26.md",
  "1596-amazon-web-services-2026-08-26.md",
  "1603-amazon-prime-air-2026-08-26.md",
  "1605-amazon-2026-08-26.md",
  "1606-amazon-2026-08-26.md",
];

// Losers must not be winners of any URL and must not be targeted winners
const targetedWinners = new Set(Object.values(targeted));
const loserSet = new Set(losers.filter((f) => !targetedWinners.has(f)));
for (const f of supersededOld) loserSet.add(f);

// ---------- rewrite pipeline.md ----------
const plPath = "data/pipeline.md";
const lines = fs.readFileSync(plPath, "utf8").split("\n");
const out = [];
const seenProcessedUrl = new Set();
const log = [];
const scoreCell = (f) => (meta[f].score ? meta[f].score + "/5" : "N/A");
const linkCell = (f) => `[${meta[f].num}](../reports/${f})`;

for (const line of lines) {
  // processed lines with a report link
  let m = line.match(
    /^- \[x\] \[(\d+)\]\((?:\.\.\/)?reports\/([^)]+)\)\s*\|\s*(\S+)\s*\|(.*)$/,
  );
  if (m) {
    const [, , linkFile, rawUrl, rest] = m;
    const u = normUrl(rawUrl);
    const restFields = rest.split("|").map((s) => s.trim());
    const company = restFields[0] || "";
    const title = restFields[1] || "";
    const w = winner[u];
    if (w) {
      if (seenProcessedUrl.has(u)) {
        log.push(`DROP duplicate processed line for ${u}`);
        continue;
      }
      seenProcessedUrl.add(u);
      const newLine = `- [x] ${linkCell(w)} | ${u} | ${company} | ${title} | ${scoreCell(w)} | PDF ❌`;
      if (newLine !== line) log.push(`REPOINT ${linkFile} -> ${w}`);
      out.push(newLine);
    } else if (byUrlArchive[u]) {
      const a = byUrlArchive[u];
      if (seenProcessedUrl.has(u)) {
        log.push(`DROP duplicate processed line for ${u}`);
        continue;
      }
      seenProcessedUrl.add(u);
      log.push(`REPOINT to archive: ${linkFile} -> archive/${a.f}`);
      out.push(
        `- [x] [${a.num}](../reports/archive/${a.f}) | ${u} | ${company} | ${title} | ${a.s ? a.s + "/5" : "N/A"} | PDF ❌ | superseded eval (archived)`,
      );
    } else {
      log.push(`REVERT to pending (no surviving report): ${u}`);
      const prior =
        restFields[2] && /\/5|N\/A/.test(restFields[2])
          ? ` | prior eval ${restFields[2]} — report file lost, re-evaluate`
          : " | report file lost, re-evaluate";
      out.push(`- [ ] ${u} | ${company} | ${title}${prior}`);
    }
    continue;
  }
  // pending lines
  m = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]+)\|\s*([^|]+)(\|.*)?$/);
  if (m) {
    const u = normUrl(m[1]);
    const w = winner[u];
    if (w) {
      if (seenProcessedUrl.has(u)) {
        log.push(`DROP pending line (already processed): ${u}`);
        continue;
      }
      seenProcessedUrl.add(u);
      log.push(`MARK processed: ${u} -> ${w}`);
      out.push(
        `- [x] ${linkCell(w)} | ${u} | ${m[2].trim()} | ${m[3].trim()} | ${scoreCell(w)} | PDF ❌`,
      );
      continue;
    }
  }
  // track URLs of already-correct processed lines for dedupe
  const um = line.match(/^- \[x\].*?\|\s*(https?:\/\/\S+)/);
  if (um) seenProcessedUrl.add(normUrl(um[1]));
  out.push(line);
}

// ---------- generate TSVs ----------
const trk = fs.readFileSync("data/applications.md", "utf8");
const trackerLinked = new Set(
  [...trk.matchAll(/\]\((?:\.\.\/)?reports\/([^)]+)\)/g)].map((x) => x[1]),
);
const finalPipeline = out.join("\n");
const pipelineLinked = new Set(
  [...finalPipeline.matchAll(/\]\((?:\.\.\/)?reports\/([^)]+)\)/g)].map(
    (x) => x[1],
  ),
);
const clean = (s) =>
  (s || "")
    .replace(/[\t|\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tsvs = [];

// targeted row-fix TSVs
for (const [row, w] of Object.entries(targeted)) {
  const mm = meta[w];
  const status = /skip/i.test(mm.decision || "") ? "SKIP" : "Evaluated";
  const note = clean(
    `Re-eval — supersedes report [${oldReportOfRow[row]}]. ${mm.hardStop || ""}`,
  ).slice(0, 240);
  tsvs.push([
    `row-fix-${row}`,
    [
      row,
      mm.date,
      rowCompany[row],
      mm.role || "",
      status,
      mm.score + "/5",
      "❌",
      `[${mm.num}](reports/${w})`,
      note,
      mm.url,
    ].join("\t"),
  ]);
}

// generic backfill TSVs: winner reports with no tracker row
const queued1252 = fs.existsSync("batch/tracker-additions/1252.tsv");
const url1252 =
  "https://www.amazon.jobs/en/jobs/10514560/technical-infrastructure-program-manager-i-data-center-power-utilization-management-planning-pump-soapstone";
for (const f of files) {
  if (loserSet.has(f) || targetedWinners.has(f) || trackerLinked.has(f))
    continue;
  const mm = meta[f];
  if (!mm.url || mm.url.includes("REDACTED")) continue;
  if (winner[mm.url] !== f) continue;
  if (parseInt(mm.num) < 2078) continue; // crash-batch scope only
  if (!pipelineLinked.has(f))
    log.push(`TSV for report with no pipeline line: ${f}`);
  if (queued1252 && mm.url === normUrl(url1252) && mm.num === "2338") {
    log.push("SKIP TSV 2338 (1252.tsv already queued)");
    continue;
  }
  if (!mm.company || !mm.role || !mm.score) {
    log.push(`SKIP TSV (missing fields): ${f}`);
    continue;
  }
  const status = /skip/i.test(mm.decision || "") ? "SKIP" : "Evaluated";
  const note = clean(
    `${mm.hardStop || mm.decision || ""} (row backfilled 2026-08-27; batch tracker TSV lost)`,
  ).slice(0, 240);
  tsvs.push([
    mm.num,
    [
      mm.num,
      mm.date,
      mm.company,
      mm.role,
      status,
      mm.score + "/5",
      "❌",
      `[${mm.num}](reports/${f})`,
      note,
      mm.url,
    ].join("\t"),
  ]);
}

// 1252.tsv sanity: if 2338 lost its URL group, remove the stale TSV
if (
  queued1252 &&
  winner[normUrl(url1252)] !==
    "2338-amazon-technical-infrastructure-program-manager-pump-soapstone-2026-08-27.md"
) {
  log.push("REMOVE stale 1252.tsv (2338 superseded by newer eval)");
  if (!DRY) fs.unlinkSync("batch/tracker-additions/1252.tsv");
}

// ---------- report ----------
console.log("== winners chosen for touched dup groups ==");
for (const [u, group] of Object.entries(byUrl)) {
  if (
    group.length > 1 &&
    group.some((g) => loserSet.has(g) || parseInt(meta[g].num) >= 2078)
  ) {
    console.log(
      `  ${u.slice(0, 78)}\n    WINNER ${winner[u]} (${meta[winner[u]].score})  losers: ${group.filter((x) => x !== winner[u]).join(", ")}`,
    );
  }
}
console.log("\n== pipeline changes ==");
log.forEach((l) => console.log("  " + l));
console.log("\n== archive after merge (" + loserSet.size + " files) ==");
[...loserSet].sort().forEach((f) => console.log("  " + f));
console.log("\n== TSVs to write: " + tsvs.length + " ==");

if (!DRY) {
  fs.writeFileSync(plPath, finalPipeline);
  for (const [name, row] of tsvs)
    fs.writeFileSync(`batch/tracker-additions/${name}.tsv`, row + "\n");
  fs.writeFileSync(
    "backups/repair-2026-08-27/archive-moves.txt",
    [...loserSet].sort().join("\n") + "\n",
  );
  console.log(
    "APPLIED: pipeline.md rewritten, " +
      tsvs.length +
      " TSVs written, archive list saved.",
  );
}
