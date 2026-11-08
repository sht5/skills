// Ask AI + AI review agent endpoints, shared by the plan and review sessions.

import fs from "node:fs";
import path from "node:path";
import { aiStatus, runClaude } from "./claude.js";
import { STREAMED } from "./session.js";
import { dataDir, ensureDir } from "./util.js";

const MAX_PLAN_CHARS = 60_000;
const MAX_DIFF_CHARS = 40_000;
const DEFAULT_ASK_MODEL = process.env.REDLINE_AI_MODEL || "sonnet";
const DEFAULT_REVIEW_MODEL = process.env.REDLINE_REVIEW_MODEL || "opus";

function truncate(s, max) {
  s = String(s ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n\n… [truncated: ${s.length - max} more characters]`;
}

function fence(body, lang = "") {
  let t = "```";
  while (String(body).includes(t)) t += "`";
  return `${t}${lang}\n${body}\n${t}`;
}

const ANSWER_RULES = [
  "Answer the user's message directly and concisely, in markdown.",
  "The material below is context for what the user is looking at: do not review, summarize or critique it unless the message asks you to.",
  "Investigate further (read files, run read-only git or glab commands) only when the question needs it.",
  "You cannot edit files here. If a change is needed, describe it; the user decides whether to send it as feedback.",
].join(" ");

/** Describe what the reviewer is looking at, for the first message of a conversation. */
function materialFor(ctx) {
  if (ctx.kind === "plan") {
    const lines = ["## Plan under review"];
    if (ctx.version) lines.push(`Version ${ctx.version}`);
    if (ctx.project) lines.push(`Project: ${ctx.project}`);
    lines.push("", truncate(ctx.plan, MAX_PLAN_CHARS));
    return lines.join("\n");
  }
  const lines = ["## Change under review"];
  if (ctx.mr) lines.push(`GitLab MR ${ctx.mr.repo}!${ctx.mr.number}: ${ctx.mr.title} (${ctx.mr.head} → ${ctx.mr.base}) ${ctx.mr.url}`);
  else if (ctx.describe()) lines.push(`Diff: ${ctx.describe()}`);
  if (ctx.root) lines.push(`Repository: ${ctx.root}`);
  lines.push("", fence(truncate(ctx.patch(), MAX_DIFF_CHARS), "diff"));
  return lines.join("\n");
}

function selectionText(sel) {
  if (!sel) return "";
  if (sel.quote) {
    return `## The user selected this passage${sel.section ? ` (in "${sel.section}")` : ""}\n\n${sel.quote
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")}`;
  }
  if (sel.file) {
    const where = sel.start == null ? "the whole file" : sel.start === sel.end ? `line ${sel.start}` : `lines ${sel.start}-${sel.end}`;
    const side = sel.side === "old" ? " (old side: removed code)" : "";
    return `## The user is asking about ${sel.file}, ${where}${side}${sel.code ? `\n\n${fence(sel.code)}` : ""}`;
  }
  return "";
}

/** Build the prompt for one turn of Ask AI. Exported for tests. */
export function buildAskPrompt(ctx, { question, mode, firstTurn, selection, notes }) {
  const parts = [];
  if (firstTurn) {
    if (mode === "session") {
      parts.push(
        `The user is now reviewing your work in Redline, a browser review UI, and has a question. ${ANSWER_RULES} Do not continue your previous task; just answer.`,
      );
    } else {
      parts.push(`You are an assistant inside Redline, a browser review UI for ${ctx.kind === "plan" ? "implementation plans" : "code changes"}. ${ANSWER_RULES}`);
    }
    parts.push(materialFor(ctx));
    if (notes) parts.push(`## The user's review notes so far\n\n${truncate(notes, 8000)}`);
  }
  const sel = selectionText(selection);
  if (sel) parts.push(sel);
  parts.push(firstTurn ? `---\n\nUser question: ${question}` : question);
  return parts.join("\n\n");
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["important", "nit", "pre_existing"] },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          end_line: { type: ["integer", "null"] },
          description: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["severity", "file", "line", "end_line", "description", "reasoning"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["findings", "summary"],
  additionalProperties: false,
};

/** Instructions for the AI review agent. Exported for tests. */
export function buildReviewPrompt(ctx, patchFile) {
  const target = ctx.mr
    ? `GitLab merge request ${ctx.mr.repo}!${ctx.mr.number} "${ctx.mr.title}" (${ctx.mr.head} → ${ctx.mr.base}), ${ctx.mr.url}. The working directory may not be a checkout of that branch, so trust the patch over local files when they disagree.`
    : `${ctx.describe()}.`;
  return `You are a code reviewer. Find problems in this change that would matter in production.

Change: ${target}
The complete unified diff is in this file; read it first: ${patchFile}

How to work:
1. Read the diff. Then read the surrounding code that the changed lines call or are called by, and any CLAUDE.md / REVIEW.md that applies, before judging anything.
2. Look for: logic errors and regressions, broken edge cases, crashes, wrong error handling, security issues with a concrete exploit path, race conditions, and clear violations of the repository's own documented rules.
3. Do not report style, formatting, naming taste, missing tests, or speculative "might be" concerns. Verify every finding by tracing the actual code; drop anything you cannot confirm.
4. Severity: "important" for a real defect introduced or exposed by this change; "nit" for a minor but concrete improvement; "pre_existing" for a real defect in code the change touches but did not introduce.
5. Location: "file" is the path as it appears in the diff; "line"/"end_line" are line numbers in the NEW version of the file (the + side). Use null lines for a whole-file finding, and null file for a finding about the change as a whole.
6. "description" is one or two sentences a developer can act on. "reasoning" shows the code path or evidence that proves it.
7. "summary" is one sentence on the overall state of the change. An empty findings list is a fine answer.

You cannot edit files. Respond only through the structured output.`;
}

/**
 * Attach Ask AI and AI review endpoints to a session's API.
 * @param {Record<string,Function>} api   the session's api map (mutated)
 * @param {object} ctx
 * @param {'plan'|'review'} ctx.kind
 * @param {string} ctx.cwd                directory Claude runs in
 * @param {string|null} ctx.sessionId     Claude Code session that opened Redline (for "Ask this session")
 * @param {string|null} [ctx.sessionCwd]  that session's directory (where --resume can find it)
 * @returns {{info: object, cleanup: () => void}}
 */
export function attachAI(api, ctx) {
  const status = aiStatus();
  const children = new Map(); // askId/jobId -> child
  const jobs = new Map();
  const info = {
    ...status,
    sessionAvailable: Boolean(ctx.sessionId),
    defaultMode: ctx.sessionId ? "session" : "fresh",
    askModel: DEFAULT_ASK_MODEL,
    reviewModel: DEFAULT_REVIEW_MODEL,
    canReview: ctx.kind === "review",
  };
  if (!status.available) return { info, cleanup() {} };

  api.ask = async (body, _q, { res }) => {
    const question = String(body.question || "").trim();
    if (!question) return { error: "Empty question" };
    const mode = body.mode === "session" && ctx.sessionId ? "session" : "fresh";
    const firstTurn = !body.conversationId;
    const prompt = buildAskPrompt(ctx, { question, mode, firstTurn, selection: body.selection, notes: body.notes });
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    const send = (o) => {
      if (!res.writableEnded) res.write(JSON.stringify(o) + "\n");
    };
    let proc;
    try {
      proc = runClaude({
        prompt,
        cwd: mode === "session" || body.conversationMode === "session" ? ctx.sessionCwd || ctx.cwd : ctx.cwd,
        model: body.model || DEFAULT_ASK_MODEL,
        resume: firstTurn ? (mode === "session" ? ctx.sessionId : undefined) : body.conversationId,
        fork: firstTurn && mode === "session",
        onEvent: send,
      });
    } catch (e) {
      send({ type: "error", error: e.message });
      res.end();
      return STREAMED;
    }
    const askId = String(body.askId || Math.random());
    children.set(askId, proc.child);
    res.on("close", () => {
      // Browser went away mid-answer: stop the child.
      if (!res.writableFinished) proc.child.kill("SIGTERM");
    });
    const r = await proc.done;
    children.delete(askId);
    if (r.ok) send({ type: "done", conversationId: r.sessionId, text: r.text });
    else send({ type: "error", error: r.error || "Ask AI failed", conversationId: r.sessionId });
    res.end();
    return STREAMED;
  };

  api["ask-cancel"] = (body) => {
    const c = children.get(String(body.askId));
    if (c) c.kill("SIGTERM");
    return { ok: Boolean(c) };
  };

  if (ctx.kind === "review") {
    api["ai-review"] = (body) => {
      const id = `job-${Date.now().toString(36)}`;
      const dir = ensureDir(path.join(dataDir(), "tmp"));
      const patchFile = path.join(dir, `${id}.patch`);
      fs.writeFileSync(patchFile, ctx.patch());
      const job = { id, status: "running", activity: [], findings: [], summary: "", error: null, started: Date.now() };
      jobs.set(id, job);
      let proc;
      try {
        proc = runClaude({
          prompt: buildReviewPrompt(ctx, patchFile),
          cwd: ctx.root || ctx.cwd,
          model: body.model || DEFAULT_REVIEW_MODEL,
          jsonSchema: REVIEW_SCHEMA,
          persist: false,
          onEvent: (ev) => {
            if (ev.type === "tool") job.activity.push(`${ev.name} ${ev.detail}`.trim());
          },
        });
      } catch (e) {
        job.status = "error";
        job.error = e.message;
        return { id };
      }
      children.set(id, proc.child);
      proc.done.then((r) => {
        children.delete(id);
        fs.rmSync(patchFile, { force: true });
        if (job.status === "cancelled") return;
        const out = r.structured;
        if (r.ok && out && Array.isArray(out.findings)) {
          job.status = "done";
          job.findings = out.findings;
          job.summary = out.summary || "";
        } else {
          job.status = "error";
          job.error = r.error || "The review agent returned no findings.";
        }
      });
      return { id };
    };
    api["ai-review-status"] = (_b, q) => {
      const job = jobs.get(q.get("id"));
      if (!job) return { error: "unknown job" };
      return { ...job, activity: job.activity.slice(-8), elapsed: Math.round((Date.now() - job.started) / 1000) };
    };
    api["ai-review-cancel"] = (body) => {
      const job = jobs.get(String(body.id));
      if (job && job.status === "running") {
        job.status = "cancelled";
        children.get(job.id)?.kill("SIGTERM");
      }
      return { ok: Boolean(job) };
    };
  }

  return {
    info,
    cleanup() {
      for (const c of children.values()) c.kill("SIGTERM");
    },
  };
}
