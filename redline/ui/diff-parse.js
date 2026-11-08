// Parse a unified diff (git / gh / glab output) into files, hunks and lines.

/**
 * @typedef {{type:'ctx'|'add'|'del', text:string, oldNo:number|null, newNo:number|null, noNewline?:boolean}} DiffLine
 * @typedef {{header:string, oldStart:number, oldLines:number, newStart:number, newLines:number, section:string, lines:DiffLine[]}} Hunk
 * @typedef {{oldPath:string|null, newPath:string|null, path:string, status:'added'|'deleted'|'modified'|'renamed'|'copied',
 *            binary:boolean, mode?:string, hunks:Hunk[], additions:number, deletions:number}} DiffFile
 */

function unquote(p) {
  if (!p) return p;
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function stripPrefix(p) {
  p = unquote(p.trim().replace(/\t.*$/, ""));
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

function pathsFromGitHeader(rest) {
  // Quoted form: "a/x y" "b/x y"
  const q = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
  if (q) return [stripPrefix(q[1]), stripPrefix(q[2])];
  // Unquoted form: a/<path> b/<path>, where <path> may contain spaces.
  const idx = rest.lastIndexOf(" b/");
  if (idx > 0) return [stripPrefix(rest.slice(0, idx)), stripPrefix(rest.slice(idx + 1))];
  return [null, null];
}

/** @returns {DiffFile[]} */
export function parseDiff(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  /** @type {DiffFile[]} */
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const hunkDone = () =>
    !hunk || (oldNo - hunk.oldStart >= hunk.oldLines && newNo - hunk.newStart >= hunk.newLines);

  const startFile = (oldPath, newPath) => {
    file = { oldPath, newPath, path: newPath || oldPath || "", status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 };
    files.push(file);
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const [a, b] = pathsFromGitHeader(line.slice(11));
      startFile(a, b);
      continue;
    }
    if (line.startsWith("--- ") && (lines[i + 1] || "").startsWith("+++ ") && hunkDone()) {
      const oldPath = stripPrefix(line.slice(4));
      const newPath = stripPrefix(lines[i + 1].slice(4));
      // Plain unified diffs (no "diff --git" line) start a file here.
      if (!file || file.hunks.length) startFile(oldPath, newPath);
      file.oldPath = oldPath;
      file.newPath = newPath;
      file.path = newPath || oldPath || file.path;
      if (oldPath == null) file.status = "added";
      else if (newPath == null) file.status = "deleted";
      i++;
      hunk = null;
      continue;
    }
    if (!file) continue;
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (h) {
      hunk = {
        header: line,
        oldStart: Number(h[1]),
        oldLines: h[2] == null ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] == null ? 1 : Number(h[4]),
        section: h[5] || "",
        lines: [],
      };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) {
      if (line.startsWith("new file mode")) {
        file.status = "added";
        file.mode = line.slice(14);
      } else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(line.slice(12));
      } else if (line.startsWith("rename to ")) {
        file.newPath = unquote(line.slice(10));
        file.path = file.newPath;
      } else if (line.startsWith("copy from ")) {
        file.status = "copied";
        file.oldPath = unquote(line.slice(10));
      } else if (line.startsWith("copy to ")) {
        file.newPath = unquote(line.slice(8));
        file.path = file.newPath;
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
      continue;
    }
    const c = line[0];
    if (c === "+") {
      hunk.lines.push({ type: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
      file.additions++;
    } else if (c === "-") {
      hunk.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
      file.deletions++;
    } else if (c === " ") {
      hunk.lines.push({ type: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === "\\") {
      const last = hunk.lines.at(-1);
      if (last) last.noNewline = true;
    } else if (line === "" && i < lines.length - 1) {
      // Some tools strip the leading space from empty context lines.
      const remaining = hunk.oldLines - (oldNo - hunk.oldStart);
      if (remaining > 0) hunk.lines.push({ type: "ctx", text: "", oldNo: oldNo++, newNo: newNo++ });
    }
  }
  for (const f of files) {
    if (f.status === "modified" && f.oldPath && f.newPath && f.oldPath !== f.newPath) f.status = "renamed";
  }
  return files;
}

/**
 * Pair a hunk's lines into side-by-side rows: deletions on the left,
 * additions on the right, context on both.
 * @returns {Array<{left:DiffLine|null, right:DiffLine|null}>}
 */
export function splitRows(hunk) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
    dels = [];
    adds = [];
  };
  for (const l of hunk.lines) {
    if (l.type === "del") dels.push(l);
    else if (l.type === "add") adds.push(l);
    else {
      flush();
      rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}
