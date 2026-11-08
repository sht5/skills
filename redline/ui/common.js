// Helpers shared by the plan and review pages.
export { escapeHtml } from "./markdown.js";

export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer;
export function toast(msg) {
  let el = $(".toast");
  if (!el) {
    el = h(`<div class="toast" role="status"></div>`);
    document.body.append(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/** Debounced draft saver: annotations survive a crash or a timed-out session. */
export function draftSaver() {
  let t;
  return (state) => {
    clearTimeout(t);
    t = setTimeout(() => api("/api/draft", state).catch(() => {}), 400);
  };
}

let decided = false;

/** Tell the server the tab is going away (a reload cancels this). */
export function watchClose() {
  window.addEventListener("pagehide", () => {
    if (!decided) navigator.sendBeacon("/api/closing", "");
  });
}

/** Post the final decision and replace the page with a confirmation. */
export async function decide(decision, extra = {}, { title, detail } = {}) {
  await api("/api/decision", { decision, ...extra });
  decided = true;
  document.body.innerHTML = "";
  document.body.append(
    h(`<div class="overlay" style="background:var(--bg)"><div class="dialog" style="text-align:center">
      <div class="done-check" style="margin:0 auto 10px">✓</div>
      <h2>${title}</h2><p>${detail}</p><p style="margin:0">You can close this tab.</p></div></div>`),
  );
  setTimeout(() => window.close(), 600);
}

/** Simple confirm dialog. Resolves to the clicked button's value or null. */
export function ask({ title, body, buttons }) {
  return new Promise((resolve) => {
    const el = h(`<div class="overlay"><div class="dialog" role="dialog" aria-modal="true">
      <h2></h2><p></p><div class="row"></div></div></div>`);
    el.querySelector("h2").textContent = title;
    el.querySelector("p").textContent = body;
    const row = el.querySelector(".row");
    for (const b of buttons) {
      const btn = h(`<button class="btn ${b.cls || ""}"></button>`);
      btn.textContent = b.label;
      btn.onclick = () => (el.remove(), resolve(b.value));
      row.append(btn);
    }
    el.addEventListener("click", (e) => e.target === el && (el.remove(), resolve(null)));
    el.addEventListener("keydown", (e) => e.key === "Escape" && (el.remove(), resolve(null)));
    document.body.append(el);
    row.lastElementChild?.focus();
  });
}

export function setupTheme(button) {
  const saved = (() => {
    try {
      return localStorage.getItem("redline-theme");
    } catch {
      return null;
    }
  })();
  if (saved) document.documentElement.dataset.theme = saved;
  button?.addEventListener("click", () => {
    const dark =
      document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("redline-theme", next);
    } catch {}
  });
}
