import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, ensureDir, isRemote, openBrowser, readJSON, writeFileAtomic } from "./util.js";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const REMOTE_PORT = 19533;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** How long a closed tab may stay closed before we treat it as "dismissed". */
const CLOSE_GRACE_MS = Number(process.env.REDLINE_CLOSE_GRACE_MS || 5000);

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function draftFile(key) {
  return path.join(dataDir(), "drafts", `${key}.json`);
}

/**
 * Start one review session: serve `page` with `payload`, open the browser,
 * and resolve when the reviewer posts a decision (or closes the tab).
 *
 * @param {object} opts
 * @param {"plan"|"review"} opts.page
 * @param {object} opts.payload          data the UI renders
 * @param {string} [opts.draftKey]       key for persisting in-progress annotations
 * @param {Record<string,(body:any, query:URLSearchParams)=>any>} [opts.api]  extra endpoints under /api/
 * @returns {Promise<{url:string, result:Promise<any>, close:()=>void}>}
 */
export async function startSession({ page, payload, draftKey, api = {} }) {
  let settle;
  const result = new Promise((r) => (settle = r));
  let decided = false;
  let closeTimer = null;

  const draft = draftKey ? readJSON(draftFile(draftKey), null) : null;
  const fullPayload = { ...payload, draft };

  const finish = (value) => {
    if (decided) return;
    decided = true;
    clearTimeout(closeTimer);
    if (draftKey && value.decision !== "dismissed") {
      try {
        fs.rmSync(draftFile(draftKey), { force: true });
      } catch {}
    }
    settle(value);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        clearTimeout(closeTimer);
        const html = fs.readFileSync(path.join(UI_DIR, `${page}.html`), "utf8");
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        return res.end(html);
      }
      if (req.method === "GET" && p.startsWith("/static/")) {
        const rel = path.normalize(p.slice("/static/".length));
        if (rel.startsWith("..") || path.isAbsolute(rel)) return sendJSON(res, 400, { error: "bad path" });
        const file = path.join(UI_DIR, rel);
        if (!fs.existsSync(file)) return sendJSON(res, 404, { error: "not found" });
        res.writeHead(200, {
          "content-type": MIME[path.extname(file)] || "application/octet-stream",
          "cache-control": "no-store",
        });
        return res.end(fs.readFileSync(file));
      }
      if (req.method === "GET" && p === "/api/payload") {
        clearTimeout(closeTimer);
        return sendJSON(res, 200, fullPayload);
      }
      if (req.method === "POST" && p === "/api/ping") {
        clearTimeout(closeTimer);
        return sendJSON(res, 200, { ok: true, decided });
      }
      if (req.method === "POST" && p === "/api/draft") {
        const body = await readBody(req);
        if (draftKey) writeFileAtomic(draftFile(draftKey), JSON.stringify(body));
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/closing") {
        // The tab is going away (close or reload). A reload re-requests the page
        // within the grace period and cancels this.
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => finish({ decision: "dismissed" }), CLOSE_GRACE_MS);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && p === "/api/decision") {
        const body = await readBody(req);
        if (!["approved", "annotated", "dismissed"].includes(body.decision)) {
          return sendJSON(res, 400, { error: "decision must be approved, annotated or dismissed" });
        }
        sendJSON(res, 200, { ok: true });
        finish(body);
        return;
      }
      const name = p.startsWith("/api/") ? p.slice(5) : null;
      if (name && api[name]) {
        const body = req.method === "POST" ? await readBody(req) : {};
        const out = await api[name](body, url.searchParams);
        return sendJSON(res, 200, out ?? {});
      }
      sendJSON(res, 404, { error: "not found" });
    } catch (e) {
      sendJSON(res, 500, { error: String(e?.message || e) });
    }
  });

  const remote = isRemote();
  const port = Number(process.env.REDLINE_PORT || (remote ? REMOTE_PORT : 0));
  const host = remote ? "0.0.0.0" : "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://localhost:${actualPort}/`;

  // Record the live session so `redline sessions` can list / reopen it.
  const sessFile = path.join(ensureDir(path.join(dataDir(), "sessions")), `${process.pid}.json`);
  writeFileAtomic(
    sessFile,
    JSON.stringify({ pid: process.pid, url, page, title: payload.title || page, started: new Date().toISOString() }),
  );

  const close = () => {
    try {
      fs.rmSync(sessFile, { force: true });
    } catch {}
    server.closeAllConnections?.();
    server.close();
  };
  process.once("exit", () => {
    try {
      fs.rmSync(sessFile, { force: true });
    } catch {}
  });

  process.stderr.write(`Redline ${page} review: ${url}\n`);
  if (remote) process.stderr.write(`(remote mode: forward port ${actualPort} to open it locally)\n`);
  openBrowser(url);

  // Give the browser a moment to receive the final response before closing.
  const done = result.then((v) => new Promise((r) => setTimeout(() => (close(), r(v)), 150)));
  return { url, result: done, close };
}
