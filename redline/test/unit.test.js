import assert from "node:assert/strict";
import { test } from "node:test";
import { composePlanDenied, composeReviewMessage, formatPlanFeedback, formatReviewFeedback, REVIEW_APPROVED, REVIEW_CLOSED } from "../src/feedback.js";
import { parsePrUrl } from "../src/git.js";
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

test("PR URL parsing", () => {
  assert.deepEqual(parsePrUrl("https://github.com/o/r/pull/12"), {
    host: "github", hostname: "github.com", owner: "o", repo: "r", number: 12, url: "https://github.com/o/r/pull/12",
  });
  assert.equal(parsePrUrl("https://gitlab.com/g/sub/proj/-/merge_requests/7").project, "g/sub/proj");
  assert.equal(parsePrUrl("https://github.com/o/r"), null);
  assert.equal(parsePrUrl("../dir"), null);
});

test("review args", () => {
  assert.deepEqual(parseReviewArgs(["--base", "main", "../x"]), {
    target: "../x", base: "main", diffType: null, patchFile: null, json: false, help: false,
  });
  assert.equal(parseReviewArgs(["--diff-type=staged"]).diffType, "staged");
  assert.throws(() => parseReviewArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => parseReviewArgs(["a", "b"]), /one directory/);
  assert.throws(() => parseReviewArgs(["--diff-type", "nope"]), /Unknown --diff-type/);
  assert.throws(() => parseReviewArgs(["--patch-file", "x.diff", "dir"]), /cannot be combined/);
});
