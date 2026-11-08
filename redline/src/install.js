// `redline install` / `redline uninstall`: wire Redline into Claude Code
// without the plugin system (user-level skills + a settings.json hook).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, run, writeFileAtomic } from "./util.js";

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["redline", "redline-review"];
const HOOK_TIMEOUT_S = 345600; // 4 days: a plan can wait for its reviewer
const MARK = "plan-hook";

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function hookCommand() {
  const onPath = run(process.platform === "win32" ? "where" : "which", ["redline"]);
  if (onPath.ok && onPath.stdout.trim()) return `redline ${MARK}`;
  const bin = path.join(PKG_ROOT, "bin", "redline.js");
  return `"${process.execPath}" "${bin}" ${MARK}`;
}

function isOurs(h) {
  return typeof h?.command === "string" && /redline(\.js")?\s+plan-hook\b/.test(h.command);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export function install({ dryRun = false } = {}) {
  const dir = claudeDir();
  const settingsFile = path.join(dir, "settings.json");
  const settings = readJSON(settingsFile, {}) || {};
  settings.hooks ||= {};
  const list = (settings.hooks.PermissionRequest ||= []);
  // Remove any previous Redline entry, then add a fresh one.
  for (const group of list) group.hooks = (group.hooks || []).filter((h) => !isOurs(h));
  settings.hooks.PermissionRequest = list.filter((g) => (g.hooks || []).length > 0);
  const command = hookCommand();
  settings.hooks.PermissionRequest.push({
    matcher: "ExitPlanMode",
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }],
  });

  const lines = [];
  for (const s of SKILLS) {
    const dst = path.join(dir, "skills", s);
    lines.push(`skill   ${dst}`);
    if (!dryRun) copyDir(path.join(PKG_ROOT, "skills", s), dst);
  }
  lines.push(`hook    ${settingsFile}  (PermissionRequest / ExitPlanMode -> ${command})`);
  if (!dryRun) writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  const onPath = command.startsWith("redline ");
  return (
    `${dryRun ? "Would install" : "Installed"}:\n  ${lines.join("\n  ")}\n` +
    (onPath
      ? ""
      : `\nNote: \`redline\` is not on your PATH, so /redline-review will not work until it is.\n` +
        `Run \`npm install -g ${PKG_ROOT}\` (or \`npm link\` inside it), then \`redline install\` again.\n`) +
    `\nRestart Claude Code (or run /hooks) to pick up the hook.`
  );
}

export function uninstall({ dryRun = false } = {}) {
  const dir = claudeDir();
  const settingsFile = path.join(dir, "settings.json");
  const lines = [];
  const settings = readJSON(settingsFile, null);
  if (settings?.hooks?.PermissionRequest) {
    for (const g of settings.hooks.PermissionRequest) g.hooks = (g.hooks || []).filter((h) => !isOurs(h));
    settings.hooks.PermissionRequest = settings.hooks.PermissionRequest.filter((g) => g.hooks.length > 0);
    if (!settings.hooks.PermissionRequest.length) delete settings.hooks.PermissionRequest;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    if (!dryRun) writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    lines.push(`hook    removed from ${settingsFile}`);
  }
  for (const s of SKILLS) {
    const dst = path.join(dir, "skills", s);
    if (fs.existsSync(dst)) {
      if (!dryRun) fs.rmSync(dst, { recursive: true, force: true });
      lines.push(`skill   removed ${dst}`);
    }
  }
  return lines.length ? `${dryRun ? "Would remove" : "Removed"}:\n  ${lines.join("\n  ")}` : "Nothing to remove.";
}
