// `redline plan-hook`: Claude Code PermissionRequest hook for ExitPlanMode.
//
// Reads the hook event on stdin, opens the plan in the browser, and prints a
// PermissionRequest decision on stdout:
//   approve  -> {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow",...}}}
//   feedback -> {"hookSpecificOutput":{...,"decision":{"behavior":"deny","message":"..."}}}
//   closed   -> no output (Claude Code falls back to its own approval prompt)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachAI } from "./ai.js";
import { CHILD_ENV } from "./claude.js";
import { composePlanDenied } from "./feedback.js";
import { startSession } from "./session.js";
import { dataDir, ensureDir, hash, lineDiff, projectSlug, readStdin, writeFileAtomic } from "./util.js";

/** Find the plan text in an ExitPlanMode tool_input. */
export function resolvePlan(toolInput = {}) {
  if (typeof toolInput.plan === "string" && toolInput.plan.trim()) return toolInput.plan;
  const file = toolInput.planFilePath || toolInput.plan_file_path;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  // Last resort: the newest plan file Claude Code wrote.
  const dir = path.join(os.homedir(), ".claude", "plans");
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest && Date.now() - newest.t < 10 * 60 * 1000) return fs.readFileSync(path.join(dir, newest.f), "utf8");
  } catch {}
  return "";
}

function planTitle(plan) {
  const m = plan.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Plan";
}

/** Version history: one folder per project, one series per Claude session. */
function historyDir(cwd, sessionId) {
  return path.join(dataDir(), "plans", projectSlug(cwd), String(sessionId || "no-session").replace(/[^\w.-]/g, "_"));
}

function loadHistory(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^v\d+\.md$/.test(f))
      .map((f) => Number(f.slice(1, -3)))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Build the decision object Claude Code expects. Exported for tests. */
export function buildHookOutput(result, toolInput, plan) {
  if (result.decision === "approved") {
    const decision = { behavior: "allow", updatedInput: { ...toolInput, plan } };
    if (result.permissionMode && result.permissionMode !== "keep") {
      decision.updatedPermissions = [{ type: "setMode", mode: result.permissionMode, destination: "session" }];
    }
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
  }
  if (result.decision === "annotated") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: composePlanDenied(result.annotations || []) },
      },
    };
  }
  return null;
}

export async function planHook() {
  const raw = await readStdin();
  // Inside an Ask AI / review-agent child of ours: never open another review.
  if (process.env[CHILD_ENV] === "1") process.exit(0);
  let event = {};
  try {
    event = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stderr.write("redline plan-hook: expected Claude Code hook JSON on stdin\n");
    process.exit(0); // never break the agent: fall back to the native prompt
  }
  const toolInput = event.tool_input || {};
  const plan = resolvePlan(toolInput);
  if (!plan.trim()) {
    process.stderr.write("redline plan-hook: no plan found in hook input; using the built-in prompt\n");
    process.exit(0);
  }
  const cwd = event.cwd || process.cwd();

  const dir = ensureDir(historyDir(cwd, event.session_id));
  const versions = loadHistory(dir);
  const lastV = versions.at(-1);
  const previous = lastV ? fs.readFileSync(path.join(dir, `v${lastV}.md`), "utf8") : null;
  let version = lastV || 0;
  if (previous !== plan) {
    version += 1;
    writeFileAtomic(path.join(dir, `v${version}.md`), plan);
  }
  // Compare against the version before this one (if the plan is unchanged, against v-1).
  const prevVersion = previous !== plan ? lastV : versions.at(-2);
  const prevText = prevVersion ? fs.readFileSync(path.join(dir, `v${prevVersion}.md`), "utf8") : null;

  const api = {};
  const ai = attachAI(api, {
    kind: "plan",
    plan,
    project: cwd,
    version,
    cwd,
    sessionId: event.session_id || null,
    sessionCwd: cwd,
  });

  const session = await startSession({
    page: "plan",
    draftKey: `plan-${hash(plan)}`,
    api,
    onFinish: ai.cleanup,
    payload: {
      ai: ai.info,
      kind: "plan",
      title: planTitle(plan),
      plan,
      project: cwd,
      version,
      previousVersion: prevVersion || null,
      diff: prevText != null ? lineDiff(prevText, plan) : null,
      permissionMode: event.permission_mode || null,
    },
  });
  const result = await session.result;

  try {
    writeFileAtomic(
      path.join(dir, `v${version}.decision.json`),
      JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2),
    );
  } catch {}

  const out = buildHookOutput(result, toolInput, plan);
  if (out) process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}
