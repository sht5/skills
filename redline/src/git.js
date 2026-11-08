import fs from "node:fs";
import path from "node:path";
import { run } from "./util.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Normalize output regardless of the user's git config (noprefix, color, external diff tools...).
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
const MAX_UNTRACKED_FILES = 500;
const MAX_UNTRACKED_BYTES = 1024 * 1024;

export const DIFF_TYPES = {
  "since-base": "Everything a PR would show: merge-base with the base branch vs working tree (incl. untracked)",
  uncommitted: "All uncommitted changes: HEAD vs working tree (incl. untracked)",
  staged: "Staged changes only",
  unstaged: "Unstaged changes (incl. untracked)",
  "last-commit": "The last commit only",
};

function git(cwd, args) {
  return run("git", args, { cwd });
}

export function repoRoot(dir) {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.stdout.trim() : null;
}

function verify(root, ref) {
  return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
}

function hasHead(root) {
  return verify(root, "HEAD");
}

export function currentBranch(root) {
  const r = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

/** Best guess at the trunk to compare against. */
export function detectBase(root) {
  const sym = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const candidates = [];
  if (sym.ok && sym.stdout.trim()) candidates.push(sym.stdout.trim());
  candidates.push("origin/main", "origin/master", "main", "master", "origin/trunk", "trunk", "origin/develop", "develop");
  return candidates.find((c) => verify(root, c)) || null;
}

function branchesLike(root, ref) {
  const r = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  if (!r.ok) return [];
  const needle = ref.toLowerCase().replace(/^origin\//, "");
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .filter((b) => b.toLowerCase().includes(needle) || needle.includes(b.toLowerCase().replace(/^origin\//, "")))
    .slice(0, 5);
}

function untrackedDiff(root) {
  const r = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!r.ok) return "";
  const files = r.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
  let out = "";
  for (const f of files) {
    let size = 0;
    try {
      const st = fs.statSync(path.join(root, f));
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > MAX_UNTRACKED_BYTES) {
      out += `diff --git a/${f} b/${f}\nnew file mode 100644\nBinary files /dev/null and b/${f} differ\n`;
      continue;
    }
    // --no-index exits 1 when files differ, which is the expected case here.
    const d = git(root, ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", f]);
    out += d.stdout;
  }
  return out;
}

/**
 * Compute a unified diff for a working tree.
 * @returns {{patch:string, describe:string, type:string, base:string|null, root:string}}
 */
export function workingTreeDiff(dir, { type = "since-base", base = null } = {}) {
  const root = repoRoot(dir);
  if (!root) throw new Error(`Not a git repository: ${dir}`);
  if (!DIFF_TYPES[type]) throw new Error(`Unknown --diff-type "${type}". Use one of: ${Object.keys(DIFF_TYPES).join(", ")}`);
  if (base && !verify(root, base)) {
    const near = branchesLike(root, base);
    throw new Error(`--base "${base}" does not resolve to a commit.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
  }
  const head = hasHead(root);
  const branch = head ? currentBranch(root) : null;
  let patch = "";
  let describe = "";
  let usedBase = null;

  if (type === "since-base") {
    usedBase = base || (head ? detectBase(root) : null);
    let from = null;
    if (usedBase && head) {
      const mb = git(root, ["merge-base", usedBase, "HEAD"]);
      if (mb.ok) from = mb.stdout.trim();
    }
    if (!from) {
      // No trunk to compare with: degrade to uncommitted changes.
      return { ...workingTreeDiff(dir, { type: "uncommitted" }), requestedType: "since-base" };
    }
    patch = git(root, ["diff", ...DIFF_FLAGS, from]).stdout + untrackedDiff(root);
    describe = `\`${branch}\` vs merge-base with \`${usedBase}\` (committed + uncommitted + untracked) in ${root}`;
  } else if (type === "uncommitted") {
    patch = git(root, ["diff", ...DIFF_FLAGS, head ? "HEAD" : EMPTY_TREE]).stdout + untrackedDiff(root);
    describe = `uncommitted changes (incl. untracked) in ${root}`;
  } else if (type === "staged") {
    patch = git(root, ["diff", "--cached", ...DIFF_FLAGS, ...(head ? [] : [EMPTY_TREE])]).stdout;
    describe = `staged changes in ${root}`;
  } else if (type === "unstaged") {
    patch = git(root, ["diff", ...DIFF_FLAGS]).stdout + untrackedDiff(root);
    describe = `unstaged changes (incl. untracked) in ${root}`;
  } else if (type === "last-commit") {
    if (!head) throw new Error("No commits yet: nothing for --diff-type last-commit");
    const parent = verify(root, "HEAD~1") ? "HEAD~1" : EMPTY_TREE;
    patch = git(root, ["diff", ...DIFF_FLAGS, parent, "HEAD"]).stdout;
    const subj = git(root, ["log", "-1", "--format=%h %s"]).stdout.trim();
    describe = `last commit (${subj}) in ${root}`;
  }
  return { patch, describe, type, base: usedBase, root };
}

/** Parse a GitHub PR or GitLab MR URL. */
export function parsePrUrl(s) {
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const gh = u.hostname === "github.com" || u.hostname.startsWith("github.");
  if (gh && parts[2] === "pull" && /^\d+$/.test(parts[3] || "")) {
    return { host: "github", hostname: u.hostname, owner: parts[0], repo: parts[1], number: Number(parts[3]), url: s };
  }
  const mrIdx = parts.indexOf("merge_requests");
  if (mrIdx > 0 && parts[mrIdx - 1] === "-" && /^\d+$/.test(parts[mrIdx + 1] || "")) {
    const project = parts.slice(0, mrIdx - 1).join("/");
    return { host: "gitlab", hostname: u.hostname, project, number: Number(parts[mrIdx + 1]), url: s };
  }
  return null;
}

/** Fetch a PR/MR diff with the platform CLI (gh or glab). */
export function fetchPr(pr) {
  if (pr.host === "github") {
    const view = run("gh", ["pr", "view", pr.url, "--json", "number,title,url,headRefName,baseRefName"]);
    if (!view.ok) throw new Error(`gh pr view failed (is gh installed and authenticated?): ${view.stderr.trim()}`);
    const meta = JSON.parse(view.stdout);
    const diff = run("gh", ["pr", "diff", pr.url, "--color=never"]);
    if (!diff.ok) throw new Error(`gh pr diff failed: ${diff.stderr.trim()}`);
    return {
      patch: diff.stdout,
      pr: {
        repo: `${pr.owner}/${pr.repo}`,
        number: meta.number,
        title: meta.title,
        url: meta.url,
        head: meta.headRefName,
        base: meta.baseRefName,
      },
    };
  }
  const repoArg = `${pr.hostname}/${pr.project}`;
  const view = run("glab", ["mr", "view", String(pr.number), "-R", repoArg, "-F", "json"]);
  if (!view.ok) throw new Error(`glab mr view failed (is glab installed and authenticated?): ${view.stderr.trim()}`);
  const meta = JSON.parse(view.stdout);
  const diff = run("glab", ["mr", "diff", String(pr.number), "-R", repoArg, "--raw"]);
  if (!diff.ok) throw new Error(`glab mr diff failed: ${diff.stderr.trim()}`);
  return {
    patch: diff.stdout,
    pr: {
      repo: pr.project,
      number: meta.iid ?? pr.number,
      title: meta.title,
      url: meta.web_url || pr.url,
      head: meta.source_branch,
      base: meta.target_branch,
    },
  };
}
