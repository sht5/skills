// End-to-end: run the real CLI, talk to its HTTP server like the browser would.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "redline.js");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Start the CLI, wait for its URL on stderr. */
function launch(args, { input, cwd, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, REDLINE_BROWSER: "none", REDLINE_PORT: "", REDLINE_REMOTE: "0", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  const url = new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => {
      stderr += d;
      const m = stderr.match(/(http:\/\/localhost:\d+\/)/);
      if (m) resolve(m[1]);
    });
    child.on("exit", (code) => reject(new Error(`exited ${code} before serving: ${stderr}`)));
  });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
  if (input != null) child.stdin.end(input);
  else child.stdin.end();
  return { url, done, child };
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  return JSON.parse(text);
}

const PLAN_EVENT = (plan, session = "s1") =>
  JSON.stringify({
    session_id: session,
    cwd: "/work/proj",
    hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode",
    tool_input: { plan },
  });

test("plan hook: approve with permission mode", async () => {
  const dataDir = tmp("rl-data-");
  const { url, done } = launch(["plan-hook"], { input: PLAN_EVENT("# My Plan\n\n1. Do it"), env: { REDLINE_DATA_DIR: dataDir } });
  const base = await url;
  const html = await (await fetch(base)).text();
  assert.match(html, /Plan Review/);
  const payload = await (await fetch(base + "api/payload")).json();
  assert.equal(payload.title, "My Plan");
  assert.equal(payload.version, 1);
  assert.equal(payload.diff, null);
  const js = await fetch(base + "static/plan.js");
  assert.equal(js.status, 200);
  assert.equal((await fetch(base + "static/../../package.json")).status, 404);
  await post(base + "api/decision", { decision: "approved", permissionMode: "acceptEdits" });
  const { code, stdout } = await done;
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(out.hookSpecificOutput.decision.updatedInput.plan, "# My Plan\n\n1. Do it");
  assert.equal(out.hookSpecificOutput.decision.updatedPermissions[0].mode, "acceptEdits");
});

test("plan hook: deny with feedback, then revised plan shows a diff", async () => {
  const dataDir = tmp("rl-data-");
  const env = { REDLINE_DATA_DIR: dataDir };
  const first = launch(["plan-hook"], { input: PLAN_EVENT("# P\n\nUse Redis.\n"), env });
  const base = await first.url;
  await post(base + "api/draft", { annotations: [{ id: "x", type: "comment", quote: "Redis", text: "draft" }] });
  await post(base + "api/decision", {
    decision: "annotated",
    annotations: [{ type: "replace", quote: "Use Redis.", text: "Use Postgres.", section: "P" }],
  });
  const r1 = await first.done;
  const out = JSON.parse(r1.stdout);
  assert.equal(out.hookSpecificOutput.decision.behavior, "deny");
  assert.match(out.hookSpecificOutput.decision.message, /YOUR PLAN WAS NOT APPROVED/);
  assert.match(out.hookSpecificOutput.decision.message, /> Use Redis\.\n\nWith:\n\n> Use Postgres\./);

  const second = launch(["plan-hook"], { input: PLAN_EVENT("# P\n\nUse Postgres.\n"), env });
  const base2 = await second.url;
  const payload = await (await fetch(base2 + "api/payload")).json();
  assert.equal(payload.version, 2);
  assert.equal(payload.previousVersion, 1);
  assert.deepEqual(
    payload.diff.filter((d) => d.op !== " ").map((d) => d.op + d.text),
    ["-Use Redis.", "+Use Postgres."],
  );
  assert.equal(payload.draft, null, "draft was keyed to the old plan text");
  await post(base2 + "api/decision", { decision: "dismissed" });
  const r2 = await second.done;
  assert.equal(r2.stdout, "", "dismissed -> no output, Claude Code shows its own prompt");
});

test("plan hook: closing the tab dismisses after the grace period", async () => {
  const { url, done } = launch(["plan-hook"], {
    input: PLAN_EVENT("# Close me"),
    env: { REDLINE_DATA_DIR: tmp("rl-data-"), REDLINE_CLOSE_GRACE_MS: "200" },
  });
  const base = await url;
  await fetch(base + "api/closing", { method: "POST" });
  const r = await done;
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("plan hook: bad input falls through quietly", () => {
  const r = spawnSync(process.execPath, [BIN, "plan-hook"], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

function makeRepo() {
  const dir = tmp("rl-repo-");
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.js"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("checkout", "-qb", "feature");
  fs.writeFileSync(path.join(dir, "a.js"), "one\nTWO\nthree\n");
  git("commit", "-qam", "change two");
  fs.writeFileSync(path.join(dir, "a.js"), "one\nTWO\nthree\nfour\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "untracked\n");
  return { dir, git };
}

test("review: since-base includes commits, edits and untracked; feedback on stdout", async () => {
  const { dir } = makeRepo();
  const { url, done } = launch(["review", dir], { env: { REDLINE_DATA_DIR: tmp("rl-data-") } });
  const base = await url;
  const payload = await (await fetch(base + "api/payload")).json();
  assert.equal(payload.mode, "git");
  assert.equal(payload.diffType, "since-base");
  assert.equal(payload.base, "main");
  assert.match(payload.patch, /\+TWO/);
  assert.match(payload.patch, /\+four/);
  assert.match(payload.patch, /\+\+\+ b\/new\.txt/);

  const staged = await (await fetch(base + "api/diff?type=last-commit")).json();
  assert.match(staged.patch, /\+TWO/);
  assert.doesNotMatch(staged.patch, /four/);

  await post(base + "api/decision", {
    decision: "annotated",
    annotations: [{ file: "a.js", side: "new", start: 2, end: 2, code: "TWO", text: "Keep lowercase" }],
  });
  const r = await done;
  assert.equal(r.code, 0);
  assert.match(r.stdout, /# Code Review Feedback/);
  assert.match(r.stdout, /## a\.js\n\n### Line 2 \(new\)\n\n```js\nTWO\n```\n\nKeep lowercase/);
});

test("review --json approved", async () => {
  const { dir } = makeRepo();
  const { url, done } = launch(["review", "--json", "--diff-type", "uncommitted"], { cwd: dir, env: { REDLINE_DATA_DIR: tmp("rl-data-") } });
  const base = await url;
  const payload = await (await fetch(base + "api/payload")).json();
  assert.doesNotMatch(payload.patch, /\+TWO/, "uncommitted excludes the commit");
  await post(base + "api/decision", { decision: "approved", annotations: [] });
  const r = await done;
  assert.deepEqual(JSON.parse(r.stdout), { decision: "approved", message: "# Code Review\n\nCode review completed — no changes requested." });
});

test("review: bad --base names near matches; non-repo fails", () => {
  const { dir } = makeRepo();
  const r = spawnSync(process.execPath, [BIN, "review", "--base", "mian", dir], { encoding: "utf8", env: { ...process.env, REDLINE_BROWSER: "none" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not resolve/);
  const r2 = spawnSync(process.execPath, [BIN, "review", tmp("rl-norepo-")], { encoding: "utf8", env: { ...process.env, REDLINE_BROWSER: "none" } });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /Not a git repository/);
});

test("review --patch-file from stdin, dismissed", async () => {
  const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  const { url, done } = launch(["review", "--patch-file", "-"], { input: patch, env: { REDLINE_DATA_DIR: tmp("rl-data-") } });
  const base = await url;
  const payload = await (await fetch(base + "api/payload")).json();
  assert.equal(payload.patch, patch);
  await post(base + "api/decision", { decision: "dismissed" });
  const r = await done;
  assert.equal(r.stdout.trim(), "Review session closed without feedback.");
});

test("install / uninstall into a temp Claude config dir", () => {
  const cfg = tmp("rl-claude-");
  fs.writeFileSync(
    path.join(cfg, "settings.json"),
    JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }] }] }, theme: "dark" }),
  );
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  let r = spawnSync(process.execPath, [BIN, "install"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [BIN, "install"], { encoding: "utf8", env }); // idempotent
  const s = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
  assert.equal(s.theme, "dark");
  assert.equal(s.hooks.PermissionRequest.length, 2);
  assert.equal(s.hooks.PermissionRequest[1].matcher, "ExitPlanMode");
  assert.match(s.hooks.PermissionRequest[1].hooks[0].command, /plan-hook$/);
  assert.ok(fs.existsSync(path.join(cfg, "skills", "redline-review", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(cfg, "skills", "redline", "SKILL.md")));
  r = spawnSync(process.execPath, [BIN, "uninstall"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const s2 = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
  assert.deepEqual(s2.hooks.PermissionRequest, [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }] }]);
  assert.ok(!fs.existsSync(path.join(cfg, "skills", "redline")));
});
