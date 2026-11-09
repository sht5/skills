// Bridge to the Claude Code CLI (`claude -p`) for Ask AI and the AI review agent.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./util.js";

/** Set in every `claude` child we start, so they can be told apart from the user's own sessions. */
export const CHILD_ENV = "REDLINE_AI_CHILD";

/** Read-only investigation: files, scoped git, scoped glab, web search. */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch"];
export const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git log:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(git merge-base:*)",
  "Bash(git ls-files:*)",
  "Bash(glab mr view:*)",
  "Bash(glab mr diff:*)",
];
export const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit", "ExitPlanMode"];

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** The `claude` executable, or null when Ask AI cannot run. */
export function claudeBin() {
  if (process.env.REDLINE_CLAUDE_BIN) return process.env.REDLINE_CLAUDE_BIN;
  const r = run(process.platform === "win32" ? "where" : "which", ["claude"]);
  return r.ok && r.stdout.trim() ? r.stdout.trim().split("\n")[0] : null;
}

export function aiStatus() {
  if (process.env.REDLINE_AI === "disabled" || process.env.REDLINE_AI === "0") {
    return { available: false, reason: "Ask AI is turned off (REDLINE_AI=disabled)." };
  }
  if (!claudeBin()) return { available: false, reason: "The `claude` CLI was not found on PATH." };
  return { available: true };
}

function parentPid(pid) {
  if (process.platform === "linux") {
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid ..." where comm may contain spaces/parens.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(after[1]);
      return ppid > 0 ? ppid : null;
    } catch {
      return null;
    }
  }
  const r = run("ps", ["-o", "ppid=", "-p", String(pid)]);
  const ppid = Number(r.stdout.trim());
  return r.ok && ppid > 0 ? ppid : null;
}

/**
 * Find the Claude Code session this process runs under, by walking up the
 * process tree to a pid that Claude Code registered in ~/.claude/sessions/<pid>.json.
 * @returns {{sessionId:string, cwd:string}|null}
 */
export function findParentClaudeSession({ startPid = process.ppid, maxHops = 10 } = {}) {
  const dir = path.join(claudeConfigDir(), "sessions");
  let pid = startPid;
  for (let i = 0; i < maxHops && pid && pid > 1; i++) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
      if (meta && typeof meta.sessionId === "string") return { sessionId: meta.sessionId, cwd: meta.cwd || null };
    } catch {}
    pid = parentPid(pid);
  }
  return null;
}

/**
 * Turn one stream-json line from `claude -p` into UI events.
 * @returns {Array<{type:string, [k:string]:any}>}
 */
export function translateEvent(e) {
  const out = [];
  if (!e || typeof e !== "object") return out;
  if (e.type === "system" && e.subtype === "init" && e.session_id) {
    out.push({ type: "session", sessionId: e.session_id, model: e.model || null });
  } else if (e.type === "stream_event") {
    const ev = e.event || {};
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") out.push({ type: "text", text: ev.delta.text });
  } else if (e.type === "assistant") {
    for (const block of e.message?.content || []) {
      if (block.type === "tool_use") out.push({ type: "tool", name: block.name, detail: toolDetail(block) });
    }
  } else if (e.type === "result") {
    out.push({
      type: "result",
      ok: !e.is_error && e.subtype === "success",
      sessionId: e.session_id || null,
      text: typeof e.result === "string" ? e.result : "",
      structured: e.structured_output ?? null,
      error: e.is_error ? String(e.result || e.subtype || "error") : null,
    });
  }
  return out;
}

function toolDetail(block) {
  const i = block.input || {};
  const v = i.file_path || i.path || i.pattern || i.command || i.query || i.description || "";
  return String(v).slice(0, 160);
}

/**
 * Run `claude -p` once, streaming translated events.
 * @param {object} o
 * @param {string} o.prompt                 written to stdin
 * @param {string} o.cwd
 * @param {string} [o.model]
 * @param {string} [o.resume]               session id to continue
 * @param {boolean} [o.fork]                with resume: fork instead of appending to it
 * @param {object} [o.jsonSchema]           structured output schema (review agent)
 * @param {boolean} [o.persist=true]        keep the session so follow-ups can resume it
 * @param {(ev:object)=>void} o.onEvent
 * @returns {{child: import('node:child_process').ChildProcess, done: Promise<{ok:boolean, sessionId:string|null, text:string, structured:any, error:string|null}>}}
 */
export function runClaude({ prompt, cwd, model, resume, fork, jsonSchema, persist = true, onEvent = () => {} }) {
  const bin = claudeBin();
  if (!bin) throw new Error("The `claude` CLI was not found on PATH.");
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", "dontAsk",
    "--tools", READ_ONLY_TOOLS.join(","),
    "--allowedTools", ALLOWED_TOOLS.join(","),
    "--disallowedTools", DISALLOWED_TOOLS.join(","),
  ];
  if (model) args.push("--model", model);
  if (resume) args.push("--resume", resume);
  if (resume && fork) args.push("--fork-session");
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  if (!persist) args.push("--no-session-persistence");

  const child = spawn(bin, args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
    env: { ...process.env, [CHILD_ENV]: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let stderr = "";
  let final = null;
  let sessionId = null;
  let text = "";
  const handle = (line) => {
    if (!line.trim()) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    for (const ev of translateEvent(e)) {
      if (ev.type === "session") sessionId = ev.sessionId;
      if (ev.type === "text") text += ev.text;
      if (ev.type === "result") {
        // Several result events can appear (one per settled turn); the last
        // non-error one with output wins, as does any error if nothing else does.
        if (!final || ev.ok || !final.ok) final = ev;
        continue;
      }
      onEvent(ev);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  const done = new Promise((resolve) => {
    child.on("error", (err) => resolve({ ok: false, sessionId, text, structured: null, error: err.message }));
    child.on("close", (code, signal) => {
      handle(buf);
      if (final) {
        resolve({
          ok: final.ok,
          sessionId: final.sessionId || sessionId,
          text: final.text || text,
          structured: final.structured,
          error: final.error,
        });
      } else {
        resolve({
          ok: false,
          sessionId,
          text,
          structured: null,
          error: signal ? "Stopped." : stderr.trim().split("\n").slice(-3).join("\n") || `claude exited with code ${code}`,
        });
      }
    });
  });
  return { child, done };
}
