import assert from "node:assert/strict";
import { test } from "node:test";
import { composePlanDenied, composeReviewMessage, formatPlanFeedback, formatReviewFeedback, REVIEW_APPROVED, REVIEW_CLOSED } from "../src/feedback.js";
import { buildAskPrompt, buildReviewPrompt } from "../src/ai.js";
import { translateEvent } from "../src/claude.js";
import { parseMrUrl } from "../src/git.js";
import { buildHookOutput } from "../src/plan.js";
import { parseReviewArgs } from "../src/review.js";
import { lineDiff } from "../src/util.js";
import { parseDiff, splitRows } from "../ui/diff-parse.js";
import { renderInline, renderMarkdown } from "../ui/markdown.js";

test("markdown: headings, lists, tasks, code, tables, escaping", () => {
  const html = renderMarkdown(
    [
      "# Title",
      "",
      "Some **bold** and `code <x>` and [link](https://example.com).",
      "",
      "- one",
      "  - nested",
      "- [x] done",
      "",
      "1. first",
      "2. second",
      "",
      "```ts",
      "const a = 1 < 2;",
      "```",
      "",
      "| a | b |",
      "|---|--:|",
      "| 1 | 2 |",
      "",
      "<script>alert(1)</script>",
    ].join("\n"),
  );
  assert.match(html, /<h1 id="title" data-line="1">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code &lt;x&gt;<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.match(html, /<li data-line="5">one<ul data-line="6"><li data-line="6">nested<\/li><\/ul><\/li>/);
  assert.match(html, /class="task"[^>]*><input type="checkbox" disabled checked> done/);
  assert.match(html, /<ol data-line="9">/);
  assert.match(html, /const a = 1 &lt; 2;/);
  assert.match(html, /<th>a<\/th><th style="text-align:right">b<\/th>/);
  assert.doesNotMatch(html, /<script>/);
});

test("markdown: javascript: links are neutralised", () => {
  assert.match(renderInline("[x](javascript:alert(1))"), /href="#"/);
});

const SAMPLE_DIFF = `diff --git a/src/app.js b/src/app.js
index 1111111..2222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,4 +1,5 @@ function main
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;

 export { a };
diff --git a/old name.txt b/new name.txt
similarity 90%
rename from old name.txt
rename to new name.txt
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;

test("diff parser: modified, renamed, added, binary", () => {
  const files = parseDiff(SAMPLE_DIFF);
  assert.equal(files.length, 4);
  const [mod, ren, add, bin] = files;
  assert.equal(mod.path, "src/app.js");
  assert.equal(mod.status, "modified");
  assert.equal(mod.additions, 2);
  assert.equal(mod.deletions, 1);
  assert.equal(mod.hunks[0].section, "function main");
  const lines = mod.hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => [l.type, l.oldNo, l.newNo]),
    [
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 3, 4],
      ["ctx", 4, 5],
    ],
  );
  assert.equal(ren.status, "renamed");
  assert.equal(ren.oldPath, "old name.txt");
  assert.equal(ren.path, "new name.txt");
  assert.equal(add.status, "added");
  assert.equal(add.hunks[0].lines.at(-1).noNewline, true);
  assert.equal(bin.binary, true);
});

test("diff parser: content lines that look like headers", () => {
  const d = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 keep
--- not a header
+++ not a header either
`;
  const [f] = parseDiff(d);
  assert.equal(f.hunks[0].lines.length, 3);
  assert.equal(f.hunks[0].lines[1].text, "-- not a header");
});

test("splitRows pairs deletions with additions", () => {
  const [mod] = parseDiff(SAMPLE_DIFF);
  const rows = splitRows(mod.hunks[0]);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].left.text, "const b = 2;");
  assert.equal(rows[1].right.text, "const b = 3;");
  assert.equal(rows[2].left, null);
  assert.equal(rows[2].right.text, "const c = 4;");
});

test("lineDiff", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(
    d.map((x) => x.op + x.text),
    [" a", "-b", "+B", " c", "+d"],
  );
});

test("plan feedback formatting", () => {
  const md = formatPlanFeedback([
    { type: "general", text: "Looks close." },
    { type: "comment", quote: "Use Redis", text: "Why not Postgres?", section: "Storage" },
    { type: "replace", quote: "3 retries", text: "5 retries" },
    { type: "delete", quote: "Rewrite the CLI" },
    { type: "insert", quote: "Step 2", text: "Step 2b: add tests" },
  ]);
  assert.match(md, /^# Plan Feedback/);
  assert.match(md, /## Overall\n\nLooks close\./);
  assert.match(md, /## 1\. Comment \(in "Storage"\)\n\n> Use Redis\n\nWhy not Postgres\?/);
  assert.match(md, /## 2\. Replace this\n\n> 3 retries\n\nWith:\n\n> 5 retries/);
  assert.match(md, /## 3\. Remove this\n\n> Rewrite the CLI/);
  assert.match(md, /## 4\. Add after this/);
  assert.match(composePlanDenied([{ type: "general", text: "x" }]), /^YOUR PLAN WAS NOT APPROVED\./);
});

test("plan hook output: approve, approve+mode, deny, dismiss", () => {
  const input = { plan: "old" };
  const a = buildHookOutput({ decision: "approved", permissionMode: "keep" }, input, "# P");
  assert.deepEqual(a, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { plan: "# P" } } },
  });
  const b = buildHookOutput({ decision: "approved", permissionMode: "acceptEdits" }, input, "# P");
  assert.deepEqual(b.hookSpecificOutput.decision.updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  const c = buildHookOutput({ decision: "annotated", annotations: [{ type: "general", text: "no" }] }, input, "# P");
  assert.equal(c.hookSpecificOutput.decision.behavior, "deny");
  assert.match(c.hookSpecificOutput.decision.message, /# Plan Feedback/);
  assert.equal(buildHookOutput({ decision: "dismissed" }, input, "# P"), null);
});

test("review feedback formatting", () => {
  const anns = [
    { file: null, text: "Add tests." },
    { file: "src/a.js", side: "new", start: 3, end: 4, code: "x()\ny()", text: "Rename", suggestion: "run()\ny()" },
    { file: "src/a.js", side: "old", start: 1, end: 1, code: "z()", text: "Why removed?" },
    { file: "README.md", side: null, start: null, end: null, text: "Docs out of date" },
  ];
  const md = formatReviewFeedback(anns, { describe: "uncommitted changes" });
  assert.match(md, /^# Code Review Feedback\n\n\*\*Diff:\*\* uncommitted changes/);
  assert.match(md, /## General\n\nAdd tests\./);
  assert.match(md, /### Line 1 \(old\)\n\n```js\nz\(\)\n```\n\nWhy removed\?/);
  assert.match(md, /### Lines 3-4 \(new\)/);
  assert.match(md, /Suggested change:\n\n```js\nrun\(\)\ny\(\)\n```/);
  assert.match(md, /## README.md\n\n### File comment\n\nDocs out of date/);

  assert.deepEqual(composeReviewMessage({ decision: "approved", annotations: [] }, {}), { decision: "approved", message: REVIEW_APPROVED });
  assert.equal(composeReviewMessage({ decision: "dismissed" }, {}).message, REVIEW_CLOSED);
  const withNotes = composeReviewMessage({ decision: "approved", annotations: anns }, {});
  assert.equal(withNotes.decision, "approved");
  assert.match(withNotes.message, /Approved with notes/);
  const denied = composeReviewMessage({ decision: "annotated", annotations: anns }, {});
  assert.equal(denied.decision, "annotated");
  assert.match(denied.message, /Treat each item above as reviewer input/);
});

test("GitLab MR URL parsing (gitlab.com, self-hosted, subgroups, /diffs)", () => {
  assert.deepEqual(parseMrUrl("https://gitlab.com/g/sub/proj/-/merge_requests/7"), {
    hostname: "gitlab.com",
    project: "g/sub/proj",
    number: 7,
    url: "https://gitlab.com/g/sub/proj/-/merge_requests/7",
    projectUrl: "https://gitlab.com/g/sub/proj",
  });
  const self = parseMrUrl("https://git.acme.io:8443/team/api/-/merge_requests/42/diffs?commit_id=abc");
  assert.equal(self.hostname, "git.acme.io:8443");
  assert.equal(self.projectUrl, "https://git.acme.io:8443/team/api");
  assert.equal(self.number, 42);
  assert.equal(parseMrUrl("https://github.com/o/r/pull/12"), null);
  assert.equal(parseMrUrl("https://gitlab.com/g/p/-/issues/3"), null);
  assert.equal(parseMrUrl("../dir"), null);
});

test("MR feedback heading and AI finding labels", () => {
  const md = formatReviewFeedback(
    [
      { file: "a.js", side: "new", start: 2, end: 2, code: "x", text: "Bug", ai: { severity: "important", reasoning: "because" } },
      { file: null, text: "Overall risky", ai: { severity: "nit", reasoning: "" } },
    ],
    { mr: { repo: "g/p", number: 9, title: "T", url: "https://gitlab.com/g/p/-/merge_requests/9", head: "f", base: "main" } },
  );
  assert.match(md, /^# MR Review: g\/p!9\n\n\*\*T\*\*\nBranch: `f` → `main`/);
  assert.match(md, /### Line 2 \(new\) — AI finding \(important\)\n\n```js\nx\n```\n\nBug\n\nReasoning: because/);
  assert.match(md, /Overall risky _\(AI finding, nit\)_/);
});

test("Ask AI prompts", () => {
  const plan = { kind: "plan", plan: "# P\n\nDo X", project: "/w", version: 2 };
  const first = buildAskPrompt(plan, { question: "Why X?", mode: "fresh", firstTurn: true, selection: { quote: "Do X", section: "P" }, notes: "1. comment" });
  assert.match(first, /^You are an assistant inside Redline/);
  assert.match(first, /## Plan under review\nVersion 2\nProject: \/w\n\n# P/);
  assert.match(first, /## The user's review notes so far\n\n1\. comment/);
  assert.match(first, /selected this passage \(in "P"\)\n\n> Do X/);
  assert.match(first, /---\n\nUser question: Why X\?$/);
  const forked = buildAskPrompt(plan, { question: "Q", mode: "session", firstTurn: true });
  assert.match(forked, /^The user is now reviewing your work in Redline/);
  assert.equal(buildAskPrompt(plan, { question: "And Y?", mode: "fresh", firstTurn: false }), "And Y?");
  const rev = { kind: "review", patch: () => "+a", describe: () => "uncommitted", root: "/r", mr: null };
  const q = buildAskPrompt(rev, { question: "ok?", mode: "fresh", firstTurn: false, selection: { file: "a.js", side: "new", start: 1, end: 3, code: "x" } });
  assert.match(q, /asking about a\.js, lines 1-3\n\n```\nx\n```\n\nok\?$/);
  assert.match(buildReviewPrompt(rev, "/tmp/p.patch"), /read it first: \/tmp\/p\.patch/);
});

test("claude stream-json translation", () => {
  assert.deepEqual(translateEvent({ type: "system", subtype: "init", session_id: "s", model: "m" }), [{ type: "session", sessionId: "s", model: "m" }]);
  assert.deepEqual(translateEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }), [{ type: "text", text: "hi" }]);
  assert.deepEqual(translateEvent({ type: "assistant", message: { content: [{ type: "text", text: "x" }, { type: "tool_use", name: "Grep", input: { pattern: "foo" } }] } }), [{ type: "tool", name: "Grep", detail: "foo" }]);
  const [r] = translateEvent({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "done", structured_output: { a: 1 } });
  assert.deepEqual(r, { type: "result", ok: true, sessionId: "s", text: "done", structured: { a: 1 }, error: null });
  assert.deepEqual(translateEvent({ type: "rate_limit_event" }), []);
});

test("review args", () => {
  assert.deepEqual(parseReviewArgs(["--base", "main", "../x"]), {
    target: "../x", base: "main", diffType: null, patchFile: null, json: false, help: false,
  });
  assert.equal(parseReviewArgs(["--diff-type=staged"]).diffType, "staged");
  assert.throws(() => parseReviewArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => parseReviewArgs(["a", "b"]), /one directory or MR URL/);
  assert.throws(() => parseReviewArgs(["--diff-type", "nope"]), /Unknown --diff-type/);
  assert.throws(() => parseReviewArgs(["--patch-file", "x.diff", "dir"]), /cannot be combined/);
});
