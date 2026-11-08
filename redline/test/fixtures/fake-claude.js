#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`: logs its invocation
// and emits a realistic event stream.
import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), input, child: process.env.REDLINE_AI_CHILD }) + "\n");
  }
  const resume = flag("--resume");
  const sessionId = args.includes("--fork-session") ? "forked-1" : resume || "fresh-1";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "system", subtype: "init", session_id: sessionId, model: flag("--model") });
  out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/y.js" } }] } });
  if (args.includes("--json-schema")) {
    const patchFile = (input.match(/read it first: (\S+)/) || [])[1];
    const sawPatch = patchFile && fs.existsSync(patchFile) && fs.readFileSync(patchFile, "utf8").includes("+");
    out({
      type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "",
      structured_output: {
        findings: sawPatch
          ? [{ severity: "important", file: "a.js", line: 2, end_line: null, description: "TWO is wrong", reasoning: "callers expect two" }]
          : [],
        summary: sawPatch ? "One real problem." : "no patch",
      },
    });
    return;
  }
  if (process.env.FAKE_CLAUDE_SLOW) {
    setTimeout(() => {}, 60_000);
    return;
  }
  for (const piece of ["Answer", " to: ", input.split("User question: ").pop().slice(0, 40)]) {
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
  }
  out({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "final" });
});
