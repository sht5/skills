import fs from "node:fs";
import path from "node:path";
import { dataDir, openBrowser } from "./util.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** `redline sessions [--open [N]] [--clean] [--json]` */
export function sessions(args) {
  const dir = path.join(dataDir(), "sessions");
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {}
  const live = [];
  for (const f of entries) {
    const file = path.join(dir, f);
    let s;
    try {
      s = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (alive(s.pid)) live.push(s);
    else fs.rmSync(file, { force: true }); // stale entry from a crashed session
  }
  live.sort((a, b) => a.started.localeCompare(b.started));
  const openIdx = args.indexOf("--open");
  if (openIdx !== -1) {
    const n = Number(args[openIdx + 1] || 1);
    const s = live[n - 1];
    if (!s) {
      process.stderr.write(`No session #${n}\n`);
      process.exit(1);
    }
    openBrowser(s.url);
    process.stdout.write(s.url + "\n");
    return;
  }
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(live, null, 2) + "\n");
    return;
  }
  if (!live.length) {
    process.stdout.write("No live Redline sessions.\n");
    return;
  }
  live.forEach((s, i) => process.stdout.write(`${i + 1}. [${s.page}] ${s.title}  ${s.url}  (pid ${s.pid}, ${s.started})\n`));
}
