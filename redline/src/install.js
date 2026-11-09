// `redline install` / `redline uninstall`: copy Redline's skills into
// ~/.claude/skills. Redline uses no hooks; install only removes the hook
// entry that versions before 0.2 added to settings.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, run, writeFileAtomic } from "./util.js";

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["redline", "redline-plan", "redline-review"];

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function onPath() {
  const r = run(process.platform === "win32" ? "where" : "which", ["redline"]);
  return r.ok && Boolean(r.stdout.trim());
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

/** Remove a hook entry left in settings.json by Redline < 0.2. Returns the settings file it changed, or null. */
function removeLegacyHook(dryRun) {
  const settingsFile = path.join(claudeDir(), "settings.json");
  const settings = readJSON(settingsFile, null);
  const list = settings?.hooks?.PermissionRequest;
  if (!Array.isArray(list) || !list.some((g) => (g.hooks || []).some(isOurs))) return null;
  for (const g of list) g.hooks = (g.hooks || []).filter((h) => !isOurs(h));
  settings.hooks.PermissionRequest = list.filter((g) => g.hooks.length > 0);
  if (!settings.hooks.PermissionRequest.length) delete settings.hooks.PermissionRequest;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (!dryRun) writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  return settingsFile;
}

export function install({ dryRun = false } = {}) {
  const dir = claudeDir();
  const lines = [];
  for (const s of SKILLS) {
    const dst = path.join(dir, "skills", s);
    lines.push(`skill   ${dst}`);
    if (!dryRun) copyDir(path.join(PKG_ROOT, "skills", s), dst);
  }
  const legacy = removeLegacyHook(dryRun);
  if (legacy) lines.push(`hook    removed the old Redline plan hook from ${legacy}`);
  return (
    `${dryRun ? "Would install" : "Installed"}:\n  ${lines.join("\n  ")}\n` +
    (onPath()
      ? ""
      : `\nNote: \`redline\` is not on your PATH, so the skills cannot run it yet.\n` +
        `Run \`npm install -g ${PKG_ROOT}\` (or \`npm link\` inside it).\n`) +
    `\nNo hooks are installed. Start a new Claude Code session to pick up the skills.`
  );
}

export function uninstall({ dryRun = false } = {}) {
  const dir = claudeDir();
  const lines = [];
  const legacy = removeLegacyHook(dryRun);
  if (legacy) lines.push(`hook    removed the old Redline plan hook from ${legacy}`);
  for (const s of SKILLS) {
    const dst = path.join(dir, "skills", s);
    if (fs.existsSync(dst)) {
      if (!dryRun) fs.rmSync(dst, { recursive: true, force: true });
      lines.push(`skill   removed ${dst}`);
    }
  }
  return lines.length ? `${dryRun ? "Would remove" : "Removed"}:\n  ${lines.join("\n  ")}` : "Nothing to remove.";
}
