// End-to-end: run the real CLI, talk to its HTTP server like the browser would.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "redline.js");
const FAKE_CLAUDE = path.join(HERE, "fixtures", "fake-claude.js");
const FAKE_GLAB = path.join(HERE, "fixtures", "fake-glab.js");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Start the CLI, wait for its URL on stderr. */
function launch(args, { input, cwd, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, REDLINE_BROWSER: "none", REDLINE_PORT: "", REDLINE_REMOTE: "0", REDLINE_CLAUDE_BIN: FAKE_CLAUDE, ...env },
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

/** POST /api/ask and collect the NDJSON events. */
async function ask(base, body) {
  const r = await fetch(base + "api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  return (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
}

function readLog(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("plan Ask AI: fork the hook's session, then follow up on the fork", async () => {
  const log = path.join(tmp("rl-log-"), "claude.jsonl");
  const cwd = tmp("rl-proj-");
  const event = JSON.stringify({ session_id: "parent-sess", cwd, tool_input: { plan: "# Cache plan\n\nUse Redis." } });
  const { url, done } = launch(["plan-hook"], { input: event, env: { REDLINE_DATA_DIR: tmp("rl-data-"), FAKE_CLAUDE_LOG: log } });
  const base = await url;
  const payload = await (await fetch(base + "api/payload")).json();
  assert.deepEqual(
    { available: payload.ai.available, sessionAvailable: payload.ai.sessionAvailable, defaultMode: payload.ai.defaultMode },
    { available: true, sessionAvailable: true, defaultMode: "session" },
  );

  const ev1 = await ask(base, { askId: "a1", question: "Why Redis?", mode: "session", selection: { quote: "Use Redis." }, model: "haiku" });
  assert.deepEqual(ev1.filter((e) => e.type === "text").map((e) => e.text).join(""), "Answer to: Why Redis?");
  assert.ok(ev1.some((e) => e.type === "tool" && e.name === "Read"));
  const doneEv = ev1.at(-1);
  assert.equal(doneEv.type, "done");
  assert.equal(doneEv.conversationId, "forked-1");

  const ev2 = await ask(base, { askId: "a2", question: "And Postgres?", conversationId: "forked-1", conversationMode: "session", mode: "session" });
  assert.equal(ev2.at(-1).type, "done");

  const [call1, call2] = readLog(log);
  const argStr = call1.args.join(" ");
  assert.match(argStr, /--resume parent-sess --fork-session/);
  assert.match(argStr, /--model haiku/);
  assert.match(argStr, /--permission-mode dontAsk/);
  assert.match(argStr, /--disallowedTools Edit,Write,NotebookEdit,ExitPlanMode/);
  assert.equal(call1.cwd, fs.realpathSync(cwd), "forked asks run in the session's directory");
  assert.equal(call1.child, "1");
  assert.match(call1.input, /^The user is now reviewing your work in Redline/);
  assert.match(call1.input, /# Cache plan/);
  assert.match(call1.input, /> Use Redis\./);
  assert.match(call2.args.join(" "), /--resume forked-1(?! --fork-session)/);
  assert.doesNotMatch(call2.args.join(" "), /--fork-session/);
  assert.equal(call2.input, "And Postgres?");

  await post(base + "api/decision", { decision: "dismissed" });
  await done;
});

test("plan hook stays silent inside a Redline AI child", () => {
  const r = spawnSync(process.execPath, [BIN, "plan-hook"], {
    input: PLAN_EVENT("# x"),
    encoding: "utf8",
    env: { ...process.env, REDLINE_AI_CHILD: "1", REDLINE_BROWSER: "none" },
    timeout: 5000,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("Ask AI: unavailable when disabled; stop cancels a running answer", async () => {
  const off = launch(["plan-hook"], { input: PLAN_EVENT("# Off"), env: { REDLINE_DATA_DIR: tmp("rl-data-"), REDLINE_AI: "disabled" } });
  const b1 = await off.url;
  const p1 = await (await fetch(b1 + "api/payload")).json();
  assert.equal(p1.ai.available, false);
  assert.match(p1.ai.reason, /REDLINE_AI=disabled/);
  assert.equal((await fetch(b1 + "api/ask", { method: "POST", body: "{}" })).status, 404);
  await post(b1 + "api/decision", { decision: "dismissed" });
  await off.done;

  const slow = launch(["plan-hook"], { input: PLAN_EVENT("# Slow"), env: { REDLINE_DATA_DIR: tmp("rl-data-"), FAKE_CLAUDE_SLOW: "1" } });
  const b2 = await slow.url;
  const pending = ask(b2, { askId: "s1", question: "hm?", mode: "fresh" });
  await new Promise((r) => setTimeout(r, 400));
  await post(b2 + "api/ask-cancel", { askId: "s1" });
  const evs = await pending;
  assert.equal(evs.at(-1).type, "error");
  await post(b2 + "api/decision", { decision: "dismissed" });
  await slow.done;
});

test("review: AI review agent returns findings; fresh Ask runs in the repo", async () => {
  const { dir } = makeRepo();
  const log = path.join(tmp("rl-log-"), "claude.jsonl");
  const { url, done } = launch(["review", dir], { env: { REDLINE_DATA_DIR: tmp("rl-data-"), FAKE_CLAUDE_LOG: log } });
  const base = await url;
  const payload = await (await fetch(base + "api/payload")).json();
  assert.equal(payload.ai.canReview, true);

  const { id } = await post(base + "api/ai-review", {});
  let job;
  for (let i = 0; i < 50; i++) {
    job = await (await fetch(base + `api/ai-review-status?id=${id}`)).json();
    if (job.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.deepEqual(job.findings, [{ severity: "important", file: "a.js", line: 2, end_line: null, description: "TWO is wrong", reasoning: "callers expect two" }]);
  assert.equal(job.summary, "One real problem.");

  const ev = await ask(base, { askId: "q", question: "Is TWO ok?", mode: "fresh", selection: { file: "a.js", side: "new", start: 2, end: 2, code: "TWO" } });
  assert.equal(ev.at(-1).conversationId, "fresh-1");
  const [reviewCall, askCall] = readLog(log);
  assert.match(reviewCall.args.join(" "), /--json-schema \{/);
  assert.match(reviewCall.args.join(" "), /--no-session-persistence/);
  assert.equal(reviewCall.cwd, fs.realpathSync(dir));
  assert.doesNotMatch(askCall.args.join(" "), /--resume/);
  assert.match(askCall.input, /## Change under review/);
  assert.match(askCall.input, /\+TWO/);
  assert.match(askCall.input, /asking about a\.js, line 2/);

  await post(base + "api/decision", {
    decision: "annotated",
    annotations: [{ file: "a.js", side: "new", start: 2, end: 2, code: "TWO", text: "TWO is wrong", ai: { severity: "important", reasoning: "callers expect two" } }],
  });
  const r = await done;
  assert.match(r.stdout, /### Line 2 \(new\) — AI finding \(important\)/);
});

test("review: GitLab MR via glab; GitHub URLs are refused", async () => {
  const env = { REDLINE_DATA_DIR: tmp("rl-data-"), REDLINE_GLAB_BIN: FAKE_GLAB };
  const mrUrl = "https://gitlab.example.com/team/svc/-/merge_requests/42";
  const { url, done } = launch(["review", mrUrl], { env });
  const base = await url;
  const payload = await (await fetch(base + "api/payload")).json();
  assert.equal(payload.mode, "mr");
  assert.equal(payload.title, "team/svc!42: Add limiter");
  assert.match(payload.patch, /\+new/);
  await post(base + "api/decision", {
    decision: "annotated",
    annotations: [{ file: "lib/x.rb", side: "new", start: 1, end: 1, code: "new", text: "Rename" }],
  });
  const r = await done;
  assert.match(r.stdout, /^# MR Review: team\/svc!42\n\n\*\*Add limiter\*\*\nBranch: `feat\/limit` → `main`\nhttps:\/\/gitlab\.example\.com\/team\/svc\/-\/merge_requests\/42/);
  assert.match(r.stdout, /```ruby|```\nnew/);

  const gh = spawnSync(process.execPath, [BIN, "review", "https://github.com/o/r/pull/1"], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(gh.status, 1);
  assert.match(gh.stderr, /GitHub pull requests are not supported/);
  const missing = spawnSync(process.execPath, [BIN, "review", "https://gitlab.example.com/team/svc/-/merge_requests/404"], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /glab mr view failed/);
});
