// `redline review [DIRECTORY | MR_URL]`: browser code review. Prints the
// reviewer's feedback on stdout when they finish.

import fs from "node:fs";
import path from "node:path";
import { attachAI } from "./ai.js";
import { findParentClaudeSession } from "./claude.js";
import { composeReviewMessage } from "./feedback.js";
import { DIFF_TYPES, fetchMr, parseMrUrl, workingTreeDiff } from "./git.js";
import { startSession } from "./session.js";
import { hash } from "./util.js";

export const REVIEW_USAGE = `Usage: redline review [options] [DIRECTORY | MR_URL]

Open a browser code review of local changes or a GitLab merge request.
The reviewer's feedback is printed on stdout when they finish.

Options:
  --base <ref>          Compare against <ref> instead of the detected trunk (git only)
  --diff-type <type>    ${Object.keys(DIFF_TYPES).join(" | ")}
                        (default: since-base)
  --patch-file <path|-> Review a static unified diff (no repository needed)
  --json                Print {"decision","message"} instead of plain text
  -h, --help            Show this help

MR_URL is a GitLab merge request (gitlab.com or self-hosted), fetched with an
authenticated \`glab\`: https://gitlab.example.com/group/project/-/merge_requests/42

Output (plain text):
  approved   "# Code Review ... no changes requested."  (or "Approved with notes")
  annotated  "# Code Review Feedback" / "# MR Review" with per-file, per-line comments
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
  if (rest.length > 1) throw new Error(`Expected one directory or MR URL, got: ${rest.join(" ")}`);
  opts.target = rest[0] || null;
  if (opts.patchFile && opts.target) throw new Error("--patch-file cannot be combined with a directory or MR URL");
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

  // The Claude Code session that ran us (via /redline-review), for "Ask this session".
  const parent = findParentClaudeSession();
  let payload;
  let ctx;
  // Live view of what is under review; the UI can switch diff type/base.
  const live = { patch: "", describe: "" };
  const api = {};
  let aiCtx;
  try {
    const mr = opts.target ? parseMrUrl(opts.target) : null;
    if (opts.target && /^https?:\/\//.test(opts.target) && !mr) {
      throw new Error(
        /github\.com/.test(opts.target)
          ? "GitHub pull requests are not supported; Redline reviews GitLab merge requests (…/-/merge_requests/<iid>) and local changes."
          : `Not a GitLab merge request URL (expected …/<group>/<project>/-/merge_requests/<iid>): ${opts.target}`,
      );
    }
    if (mr) {
      if (opts.base || opts.diffType) throw new Error("--base / --diff-type do not apply to MR reviews");
      const { patch, mr: meta } = fetchMr(mr);
      live.patch = patch;
      ctx = { mr: meta };
      payload = { kind: "review", mode: "mr", title: `${meta.repo}!${meta.number}: ${meta.title}`, patch, mr: meta };
      aiCtx = { kind: "review", cwd: parent?.cwd || process.cwd(), root: null, mr: meta };
    } else if (opts.patchFile) {
      const patch = opts.patchFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.patchFile, "utf8");
      const name = opts.patchFile === "-" ? "stdin" : path.resolve(opts.patchFile);
      live.patch = patch;
      live.describe = `patch file ${name}`;
      ctx = { describe: live.describe };
      payload = { kind: "review", mode: "patch", title: `Patch: ${path.basename(name)}`, patch, describe: ctx.describe };
      aiCtx = { kind: "review", cwd: parent?.cwd || process.cwd(), root: null, mr: null };
    } else {
      const dir = path.resolve(opts.target || ".");
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
      const d = workingTreeDiff(dir, { type: opts.diffType || "since-base", base: opts.base });
      live.patch = d.patch;
      live.describe = d.describe;
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
      aiCtx = { kind: "review", cwd: d.root, root: d.root, mr: null };
      api.diff = (_body, q) => {
        const next = workingTreeDiff(dir, { type: q.get("type") || "since-base", base: q.get("base") || null });
        live.patch = next.patch;
        live.describe = next.describe;
        ctx = { describe: next.describe };
        return { patch: next.patch, describe: next.describe, diffType: next.type, base: next.base };
      };
    }
  } catch (e) {
    process.stderr.write(`redline review: ${e.message}\n`);
    process.exit(1);
  }

  const ai = attachAI(api, {
    ...aiCtx,
    sessionId: parent?.sessionId || null,
    // Ask this session must run where that session lives, or --resume cannot find it.
    sessionCwd: parent?.cwd || null,
    patch: () => live.patch,
    describe: () => live.describe,
  });
  payload.ai = ai.info;

  const draftKey = `review-${hash(payload.mode + (payload.root || payload.mr?.url || payload.describe || ""))}`;
  const session = await startSession({ page: "review", payload, draftKey, api, onFinish: ai.cleanup });
  const result = await session.result;
  const out = composeReviewMessage(result, ctx);
  process.stdout.write((opts.json ? JSON.stringify(out) : out.message) + "\n");
  process.exit(0);
}
