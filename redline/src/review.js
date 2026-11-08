// `redline review [DIRECTORY | PR_URL]`: browser code review. Prints the
// reviewer's feedback on stdout when they finish.

import fs from "node:fs";
import path from "node:path";
import { composeReviewMessage } from "./feedback.js";
import { DIFF_TYPES, fetchPr, parsePrUrl, workingTreeDiff } from "./git.js";
import { startSession } from "./session.js";
import { hash } from "./util.js";

export const REVIEW_USAGE = `Usage: redline review [options] [DIRECTORY | PR_URL]

Open a browser code review of local changes or a GitHub PR / GitLab MR.
The reviewer's feedback is printed on stdout when they finish.

Options:
  --base <ref>          Compare against <ref> instead of the detected trunk (git only)
  --diff-type <type>    ${Object.keys(DIFF_TYPES).join(" | ")}
                        (default: since-base)
  --patch-file <path|-> Review a static unified diff (no repository needed)
  --json                Print {"decision","message"} instead of plain text
  -h, --help            Show this help

Output (plain text):
  approved   "# Code Review ... no changes requested."  (or "Approved with notes")
  annotated  "# Code Review Feedback" with per-file, per-line comments
  closed     "Review session closed without feedback."`;

export function parseReviewArgs(argv) {
  const opts = { target: null, base: null, diffType: null, patchFile: null, json: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--base") opts.base = val();
    else if (a.startsWith("--base=")) opts.base = a.slice(7);
    else if (a === "--diff-type") opts.diffType = val();
    else if (a.startsWith("--diff-type=")) opts.diffType = a.slice(12);
    else if (a === "--patch-file") opts.patchFile = val();
    else if (a.startsWith("--patch-file=")) opts.patchFile = a.slice(13);
    else if (a.startsWith("-") && a !== "-") throw new Error(`Unknown option ${a}. Run "redline review --help".`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new Error(`Expected one directory or PR URL, got: ${rest.join(" ")}`);
  opts.target = rest[0] || null;
  if (opts.patchFile && opts.target) throw new Error("--patch-file cannot be combined with a directory or PR URL");
  if (opts.patchFile && (opts.base || opts.diffType)) throw new Error("--patch-file cannot be combined with --base / --diff-type");
  if (opts.diffType && !DIFF_TYPES[opts.diffType]) {
    throw new Error(`Unknown --diff-type "${opts.diffType}". Use one of: ${Object.keys(DIFF_TYPES).join(", ")}`);
  }
  return opts;
}

export async function review(argv) {
  let opts;
  try {
    opts = parseReviewArgs(argv);
  } catch (e) {
    process.stderr.write(`redline review: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(REVIEW_USAGE + "\n");
    return;
  }

  let payload;
  let ctx;
  const api = {};
  try {
    const pr = opts.target ? parsePrUrl(opts.target) : null;
    if (opts.target && /^https?:\/\//.test(opts.target) && !pr) {
      throw new Error(`Not a GitHub PR or GitLab MR URL: ${opts.target}`);
    }
    if (pr) {
      if (opts.base || opts.diffType) throw new Error("--base / --diff-type do not apply to PR reviews");
      const { patch, pr: meta } = fetchPr(pr);
      ctx = { pr: meta };
      payload = { kind: "review", mode: "pr", title: `${meta.repo}#${meta.number}: ${meta.title}`, patch, pr: meta };
    } else if (opts.patchFile) {
      const patch = opts.patchFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.patchFile, "utf8");
      const name = opts.patchFile === "-" ? "stdin" : path.resolve(opts.patchFile);
      ctx = { describe: `patch file ${name}` };
      payload = { kind: "review", mode: "patch", title: `Patch: ${path.basename(name)}`, patch, describe: ctx.describe };
    } else {
      const dir = path.resolve(opts.target || ".");
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
      const d = workingTreeDiff(dir, { type: opts.diffType || "since-base", base: opts.base });
      ctx = { describe: d.describe };
      payload = {
        kind: "review",
        mode: "git",
        title: path.basename(d.root),
        root: d.root,
        patch: d.patch,
        describe: d.describe,
        diffType: d.type,
        base: d.base,
        diffTypes: DIFF_TYPES,
      };
      // Let the reviewer switch diff type / base inside the UI.
      api.diff = (_body, q) => {
        const next = workingTreeDiff(dir, { type: q.get("type") || "since-base", base: q.get("base") || null });
        ctx = { describe: next.describe };
        return { patch: next.patch, describe: next.describe, diffType: next.type, base: next.base };
      };
    }
  } catch (e) {
    process.stderr.write(`redline review: ${e.message}\n`);
    process.exit(1);
  }

  const draftKey = `review-${hash(payload.mode + (payload.root || payload.pr?.url || payload.describe || ""))}`;
  const session = await startSession({ page: "review", payload, draftKey, api });
  const result = await session.result;
  const out = composeReviewMessage(result, ctx);
  process.stdout.write((opts.json ? JSON.stringify(out) : out.message) + "\n");
  process.exit(0);
}
