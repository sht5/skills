// `redline plan <file>`: browser review of a plan written to a markdown file.
//
// No hooks: Claude runs this command itself (via the redline-plan skill), it
// blocks until the reviewer decides, and the decision is printed on stdout:
//   approved   "# Plan Approved" (+ optional notes to follow while implementing)
//   annotated  "YOUR PLAN WAS NOT APPROVED. ..." + "# Plan Feedback"
//   dismissed  "Plan review closed without a decision."

import fs from "node:fs";
import path from "node:path";
import { attachAI } from "./ai.js";
import { findParentClaudeSession } from "./claude.js";
import { composePlanMessage } from "./feedback.js";
import { startSession } from "./session.js";
import { dataDir, ensureDir, hash, lineDiff, projectSlug, writeFileAtomic } from "./util.js";

export const PLAN_USAGE = `Usage: redline plan [--json] <PLAN_FILE | ->

Open a markdown plan in the browser for review. Blocks until the reviewer
approves, requests changes, or closes the tab; the decision is printed on stdout.
Run it again on the revised file: the reviewer sees what changed since last time.

Options:
  --json        Print {"decision","message"} instead of plain text
  -h, --help    Show this help

Output (plain text):
  approved   "# Plan Approved ..."            (may include notes to follow)
  annotated  "YOUR PLAN WAS NOT APPROVED. ..." followed by "# Plan Feedback"
  closed     "Plan review closed without a decision."`;

export function parsePlanArgs(argv) {
  const opts = { file: null, json: false, help: false };
  const rest = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a.startsWith("-") && a !== "-") throw new Error(`Unknown option ${a}. Run "redline plan --help".`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new Error(`Expected one plan file, got: ${rest.join(" ")}`);
  opts.file = rest[0] || null;
  if (!opts.file && !opts.help) throw new Error("Missing the plan file. Write the plan to a markdown file and pass its path.");
  return opts;
}

function planTitle(plan) {
  const m = plan.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Plan";
}

/** Version history: one folder per project, one series per plan file. */
function historyDir(cwd, file) {
  return path.join(dataDir(), "plans", projectSlug(cwd), hash(file || "stdin", 12));
}

function loadHistory(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^v\d+\.md$/.test(f))
      .map((f) => Number(f.slice(1, -3)))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function planCommand(argv) {
  let opts;
  try {
    opts = parsePlanArgs(argv);
  } catch (e) {
    process.stderr.write(`redline plan: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(PLAN_USAGE + "\n");
    return;
  }

  const cwd = process.cwd();
  const file = opts.file === "-" ? null : path.resolve(opts.file);
  let plan;
  try {
    plan = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  } catch (e) {
    process.stderr.write(`redline plan: cannot read ${file || "stdin"}: ${e.message}\n`);
    process.exit(1);
  }
  if (!plan.trim()) {
    process.stderr.write(`redline plan: the plan is empty\n`);
    process.exit(1);
  }

  const dir = ensureDir(historyDir(cwd, file));
  const versions = loadHistory(dir);
  const lastV = versions.at(-1);
  const previous = lastV ? fs.readFileSync(path.join(dir, `v${lastV}.md`), "utf8") : null;
  let version = lastV || 0;
  if (previous !== plan) {
    version += 1;
    writeFileAtomic(path.join(dir, `v${version}.md`), plan);
  }
  // Compare against the version before this one (if unchanged, against v-1).
  const prevVersion = previous !== plan ? lastV : versions.at(-2);
  const prevText = prevVersion ? fs.readFileSync(path.join(dir, `v${prevVersion}.md`), "utf8") : null;

  // The Claude Code session that ran us, for Ask AI's "This session".
  const parent = findParentClaudeSession();
  const api = {};
  const ai = attachAI(api, {
    kind: "plan",
    plan,
    project: cwd,
    version,
    cwd,
    sessionId: parent?.sessionId || null,
    sessionCwd: parent?.cwd || null,
  });

  const session = await startSession({
    page: "plan",
    draftKey: `plan-${hash(plan)}`,
    api,
    onFinish: ai.cleanup,
    payload: {
      ai: ai.info,
      kind: "plan",
      title: planTitle(plan),
      plan,
      file,
      project: cwd,
      version,
      previousVersion: prevVersion || null,
      diff: prevText != null ? lineDiff(prevText, plan) : null,
    },
  });
  const result = await session.result;

  try {
    writeFileAtomic(path.join(dir, `v${version}.decision.json`), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
  } catch {}

  const out = composePlanMessage(result, file);
  process.stdout.write((opts.json ? JSON.stringify(out) : out.message) + "\n");
  process.exit(0);
}
