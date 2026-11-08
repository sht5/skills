import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where Redline keeps plan history and annotation drafts. */
export function dataDir() {
  const dir =
    process.env.REDLINE_DATA_DIR ||
    (process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "redline")
      : path.join(os.homedir(), ".redline"));
  return dir;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function hash(text, len = 16) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, len);
}

/** A filesystem-safe, readable slug for a project directory. */
export function projectSlug(dir) {
  const base = path.basename(dir || "project").replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
  return `${base}-${hash(dir || "", 8)}`;
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Run a command synchronously; never throws. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout || "",
    stderr: (r.stderr || "") + (r.error ? String(r.error.message) : ""),
  };
}

/** Open a URL in the user's browser, honoring REDLINE_BROWSER. */
export function openBrowser(url) {
  const pref = process.env.REDLINE_BROWSER;
  if (pref === "none") return;
  let cmd;
  let args;
  if (pref) {
    if (process.platform === "darwin") {
      cmd = "open";
      args = ["-a", pref, url];
    } else {
      cmd = pref;
      args = [url];
    }
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed on stderr anyway */
  }
}

/** True when this looks like an SSH / devcontainer session. */
export function isRemote() {
  const v = process.env.REDLINE_REMOTE;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

/**
 * Line-level diff (LCS). Returns [{op: ' '|'+'|'-', text}].
 * Plans are small, so the O(n*m) table is fine; we trim common
 * prefix/suffix first to keep it cheap.
 */
export function lineDiff(oldText, newText) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  const out = [];
  for (let i = 0; i < start; i++) out.push({ op: " ", text: a[i] });
  if (n * m > 4_000_000) {
    // Too large for LCS: fall back to remove-all/add-all.
    for (const t of A) out.push({ op: "-", text: t });
    for (const t of B) out.push({ op: "+", text: t });
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        out.push({ op: " ", text: A[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ op: "-", text: A[i++] });
      } else {
        out.push({ op: "+", text: B[j++] });
      }
    }
    while (i < n) out.push({ op: "-", text: A[i++] });
    while (j < m) out.push({ op: "+", text: B[j++] });
  }
  for (let i = endA; i < a.length; i++) out.push({ op: " ", text: a[i] });
  return out;
}
