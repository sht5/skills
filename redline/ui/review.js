import { $, $$, api, ask, decide, draftSaver, escapeHtml, h, setupTheme, toast, uid, watchClose } from "./common.js";
import { createAskPanel } from "./ask.js";
import { parseDiff, splitRows } from "./diff-parse.js";

const BIG_FILE_LINES = 1500;

const state = {
  annotations: [], // {id, file, side, start, end, code, text, suggestion}
  viewed: {}, // path -> true
  layout: "unified",
};
let payload;
let files = [];
let selection = null; // {file, side, start, end}
const saveDraft = draftSaver();
let askPanel;

init().catch((e) => {
  $("#cards").innerHTML = `<div class="notice">Failed to load: ${escapeHtml(e.message)}</div>`;
});

async function init() {
  payload = await api("/api/payload");
  setupTheme($("#theme"));
  watchClose();
  document.title = `${payload.title} · Code Review`;
  $("#crumb").innerHTML = `<strong>${escapeHtml(payload.title)}</strong>`;
  try {
    state.layout = localStorage.getItem("redline-layout") || "unified";
  } catch {}
  if (payload.draft) {
    state.annotations = payload.draft.annotations || [];
    state.viewed = payload.draft.viewed || {};
    if (state.annotations.length) toast("Restored your unsent comments");
  }
  if (payload.mode === "git") setupGitControls();
  $$("#layoutseg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.l === state.layout);
    b.onclick = () => {
      state.layout = b.dataset.l;
      try {
        localStorage.setItem("redline-layout", state.layout);
      } catch {}
      $$("#layoutseg button").forEach((x) => x.classList.toggle("on", x === b));
      renderCards();
    };
  });
  $("#filter").addEventListener("input", renderFileList);
  $("#addgen").onclick = addGeneral;
  $("#general").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addGeneral();
    }
  });
  $("#send").onclick = sendFeedback;
  $("#approve").onclick = approve;
  $("#close").onclick = closeSession;
  $("#cards").addEventListener("click", onCardsClick);
  setupAI();
  loadPatch(payload.patch, payload.describe || payload.mr?.url || "");
}

function setupGitControls() {
  $("#gitctl").hidden = false;
  const sel = $("#difftype");
  for (const [k, desc] of Object.entries(payload.diffTypes || {})) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    o.title = desc;
    sel.append(o);
  }
  sel.value = payload.diffType;
  $("#base").value = payload.base || "";
  const reload = async () => {
    document.body.classList.add("loading");
    try {
      const q = new URLSearchParams({ type: sel.value });
      if ($("#base").value.trim()) q.set("base", $("#base").value.trim());
      const d = await api(`/api/diff?${q}`);
      payload.diffType = d.diffType;
      payload.base = d.base;
      sel.value = d.diffType;
      loadPatch(d.patch, d.describe);
    } catch (e) {
      toast(e.message);
    } finally {
      document.body.classList.remove("loading");
    }
  };
  sel.onchange = reload;
  $("#base").addEventListener("keydown", (e) => e.key === "Enter" && reload());
}

function loadPatch(patch, describe) {
  files = parseDiff(patch);
  const adds = files.reduce((s, f) => s + f.additions, 0);
  const dels = files.reduce((s, f) => s + f.deletions, 0);
  $("#summary").innerHTML = `<span><b>${files.length}</b> file${files.length === 1 ? "" : "s"}</span>
    <span class="plus">+${adds}</span><span class="minus">−${dels}</span>
    <span class="desc">${escapeHtml(describe || "")}</span>`;
  selection = null;
  renderFileList();
  renderCards();
  refreshCounts();
}

/* ---------- file list ---------- */

const STATUS = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };

function splitPath(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

function renderFileList() {
  const q = $("#filter").value.trim().toLowerCase();
  const list = $("#files");
  list.innerHTML = "";
  files.forEach((f, idx) => {
    if (q && !f.path.toLowerCase().includes(q)) return;
    const [dir, name] = splitPath(f.path);
    const notes = state.annotations.filter((a) => a.file === f.path).length;
    const el = h(`<div class="fitem${state.viewed[f.path] ? " viewed" : ""}" title="${escapeHtml(f.path)}">
      <span class="fstat st-${f.status}">${STATUS[f.status]}</span>
      <span class="fname"><bdi><span class="dir">${escapeHtml(dir)}</span>${escapeHtml(name)}</bdi></span>
      ${notes ? `<span class="fnotes">${notes}</span>` : ""}
      <span class="fcount">${f.binary ? "bin" : `+${f.additions} −${f.deletions}`}</span></div>`);
    el.onclick = () => {
      const card = $(`#file-${idx}`);
      card.classList.remove("collapsed");
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    list.append(el);
  });
  if (!files.length) list.append(h(`<div class="empty">No changes.</div>`));
  const viewed = files.filter((f) => state.viewed[f.path]).length;
  $("#viewedtxt").textContent = files.length ? `${viewed} / ${files.length} files viewed` : "";
  $("#prog").style.width = files.length ? `${(viewed / files.length) * 100}%` : "0";
}

/* ---------- diff cards ---------- */

function renderCards() {
  const root = $("#cards");
  root.innerHTML = "";
  if (!files.length) {
    root.append(h(`<div class="card"><div class="notice">Nothing to review for this comparison. Try another diff type.</div></div>`));
  }
  files.forEach((f, idx) => root.append(renderCard(f, idx)));
}

function renderCard(f, idx) {
  const total = f.additions + f.deletions;
  const collapsed = state.viewed[f.path] || total > BIG_FILE_LINES;
  const from = f.status === "renamed" || f.status === "copied" ? `<span class="from">${escapeHtml(f.oldPath)} → </span>` : "";
  const card = h(`<section class="card${collapsed ? " collapsed" : ""}" id="file-${idx}" data-idx="${idx}">
    <div class="card-head" data-act="toggle">
      <span class="chev">▾</span>
      <span class="fstat st-${f.status}">${STATUS[f.status]}</span>
      <span class="cpath">${from}${escapeHtml(f.path)}</span>
      <span class="fcount">${f.binary ? "" : `<span class="plus">+${f.additions}</span> <span class="minus">−${f.deletions}</span>`}</span>
      <span class="spacer"></span>
      <button class="btn small ghost" data-act="file-comment">Comment on file</button>
      <label><input type="checkbox" data-act="viewed"${state.viewed[f.path] ? " checked" : ""}> Viewed</label>
    </div>
    <div class="card-body"></div></section>`);
  if (!collapsed) fillCard(card, f);
  return card;
}

function fillCard(card, f) {
  const body = card.querySelector(".card-body");
  if (body.dataset.filled) return;
  body.dataset.filled = "1";
  if (f.binary) {
    body.innerHTML = `<div class="notice">Binary file not shown.</div>`;
  } else if (!f.hunks.length) {
    body.innerHTML = `<div class="notice">${f.status === "renamed" ? "File renamed without changes." : "No textual changes (mode change or empty file)."}</div>`;
  } else {
    body.innerHTML = state.layout === "split" ? splitTable(f) : unifiedTable(f);
  }
  renderThreads(card, f);
}

function codeCell(l, extra = "") {
  const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
  return `<td class="code ${extra}" data-sign="${sign}">${escapeHtml(l.text)}${l.noNewline ? ' <span title="No newline at end of file">⏎̸</span>' : ""}</td>`;
}

function unifiedTable(f) {
  let rows = "";
  for (const hk of f.hunks) {
    rows += `<tr class="hunk"><td colspan="3">${escapeHtml(hk.header)}</td></tr>`;
    for (const l of hk.lines) {
      const side = l.type === "del" ? "old" : "new";
      const no = side === "old" ? l.oldNo : l.newNo;
      rows += `<tr class="${l.type}" data-old="${l.oldNo ?? ""}" data-new="${l.newNo ?? ""}">
        <td class="num can" data-side="${side}" data-no="${no}">${l.oldNo ?? ""}</td>
        <td class="num can" data-side="${side}" data-no="${no}">${l.newNo ?? ""}</td>${codeCell(l)}</tr>`;
    }
  }
  return `<table class="diff unified">${rows}</table>`;
}

function splitTable(f) {
  let rows = "";
  for (const hk of f.hunks) {
    rows += `<tr class="hunk"><td colspan="4">${escapeHtml(hk.header)}</td></tr>`;
    for (const { left, right } of splitRows(hk)) {
      const L = left
        ? `<td class="num can ${left.type}" data-side="old" data-no="${left.oldNo}">${left.oldNo}</td>${codeCell(left, left.type)}`
        : `<td class="num empty"></td><td class="code empty"></td>`;
      const R = right
        ? `<td class="num can ${right.type} sep-l" data-side="new" data-no="${right.newNo}">${right.newNo}</td>${codeCell(right, `${right.type} sep`)}`
        : `<td class="num empty"></td><td class="code empty sep"></td>`;
      rows += `<tr data-old="${left?.oldNo ?? ""}" data-new="${right?.newNo ?? ""}">${L}${R}</tr>`;
    }
  }
  return `<table class="diff split">${rows}</table>`;
}

function findRow(card, side, no) {
  return card.querySelector(`tr[data-${side}="${no}"]`);
}

/** Lines of code (from the diff) covered by a selection. */
function codeFor(f, side, start, end) {
  const out = [];
  for (const hk of f.hunks) {
    for (const l of hk.lines) {
      const no = side === "old" ? l.oldNo : l.newNo;
      if (no != null && no >= start && no <= end && (side === "old" ? l.type !== "add" : l.type !== "del")) out.push(l.text);
    }
  }
  return out.join("\n");
}

/* ---------- interaction ---------- */

function onCardsClick(e) {
  const card = e.target.closest(".card");
  if (!card) return;
  const f = files[Number(card.dataset.idx)];
  const act = e.target.closest("[data-act]")?.dataset.act;

  if (act === "viewed") {
    e.stopPropagation();
    const on = e.target.checked;
    if (on) state.viewed[f.path] = true;
    else delete state.viewed[f.path];
    card.classList.toggle("collapsed", on);
    if (!on) fillCard(card, f);
    renderFileList();
    persist();
    return;
  }
  if (act === "file-comment") {
    e.stopPropagation();
    card.classList.remove("collapsed");
    fillCard(card, f);
    openForm(card, f, { file: f.path, side: null, start: null, end: null });
    return;
  }
  if (act === "toggle" && !e.target.closest("label, button")) {
    card.classList.toggle("collapsed");
    if (!card.classList.contains("collapsed")) fillCard(card, f);
    return;
  }
  const num = e.target.closest("td.num.can");
  if (num) {
    const side = num.dataset.side;
    const no = Number(num.dataset.no);
    if (e.shiftKey && selection && selection.file === f.path && selection.side === side) {
      selection = { file: f.path, side, start: Math.min(selection.anchor, no), end: Math.max(selection.anchor, no), anchor: selection.anchor };
    } else {
      selection = { file: f.path, side, start: no, end: no, anchor: no };
    }
    getSelection()?.removeAllRanges();
    paintSelection();
    openForm(card, f, selection);
    return;
  }
  const cmtAct = e.target.closest("[data-cmt]");
  if (cmtAct) {
    const a = state.annotations.find((x) => x.id === cmtAct.dataset.id);
    if (!a) return;
    if (cmtAct.dataset.cmt === "del") {
      state.annotations = state.annotations.filter((x) => x !== a);
      rerenderCard(card, f);
      persist();
    } else if (cmtAct.dataset.cmt === "edit") {
      openForm(card, f, a, a);
    }
  }
}

function paintSelection() {
  $$("tr.sel, td.sel").forEach((r) => r.classList.remove("sel"));
  if (!selection || selection.start == null) return;
  const idx = files.findIndex((f) => f.path === selection.file);
  const card = $(`#file-${idx}`);
  if (!card) return;
  for (let n = selection.start; n <= selection.end; n++) {
    const row = findRow(card, selection.side, n);
    if (!row) continue;
    if (state.layout === "split") {
      const cells = row.querySelectorAll("td");
      const [a, b] = selection.side === "old" ? [0, 1] : [2, 3];
      cells[a]?.classList.add("sel");
      cells[b]?.classList.add("sel");
    } else row.classList.add("sel");
  }
}

function closeForms() {
  $$("tr.form-row, .form-wrap").forEach((r) => r.remove());
}

function insertAfterRow(card, side, end, el) {
  const row = end != null ? findRow(card, side, end) : null;
  const table = card.querySelector("table.diff");
  const cols = state.layout === "split" ? 4 : 3;
  if (row && table) {
    // Skip past existing thread rows so the form lands after them.
    let anchor = row;
    while (anchor.nextElementSibling?.classList.contains("thread")) anchor = anchor.nextElementSibling;
    const tr = h(`<table><tr class="thread form-row"><td colspan="${cols}"></td></tr></table>`).querySelector("tr");
    tr.firstElementChild.append(el);
    anchor.after(tr);
    return tr;
  }
  const wrap = h(`<div class="form-wrap" style="padding:8px 12px"></div>`);
  wrap.append(el);
  card.querySelector(".card-body").prepend(wrap);
  return wrap;
}

function openForm(card, f, target, existing) {
  closeForms();
  const lines = target.start == null ? "the whole file" : target.start === target.end ? `line ${target.start}` : `lines ${target.start}–${target.end}`;
  const code = target.start == null ? "" : codeFor(f, target.side, target.start, target.end);
  const canSuggest = target.start != null && target.side === "new";
  const form = h(`<div class="form">
    <div class="label">Comment on ${lines}${target.side === "old" ? " (removed code)" : ""}</div>
    <textarea class="input" rows="3" placeholder="What should change? (⌘/Ctrl+Enter to save)"></textarea>
    <textarea class="input sugg" rows="3" hidden spellcheck="false"></textarea>
    <div class="row">
      ${canSuggest ? `<button class="btn small" data-f="sugg">± Suggest change</button>` : ""}
      ${payload.ai?.available ? `<button class="btn small" data-f="ask"><span class="spark">✦</span> Ask AI</button>` : ""}
      <span class="spacer"></span>
      <button class="btn small ghost" data-f="cancel">Cancel</button>
      <button class="btn small primary" data-f="save">${existing ? "Update" : "Comment"}</button>
    </div></div>`);
  const ta = form.querySelector("textarea");
  const sugg = form.querySelector(".sugg");
  if (existing) {
    ta.value = existing.text || "";
    if (existing.suggestion != null) {
      sugg.hidden = false;
      sugg.value = existing.suggestion;
    }
  }
  const save = () => {
    const text = ta.value.trim();
    const suggestion = sugg.hidden ? null : sugg.value;
    if (!text && (suggestion == null || suggestion === code)) {
      ta.focus();
      return;
    }
    if (existing) {
      existing.text = text;
      existing.suggestion = suggestion;
    } else {
      state.annotations.push({ id: uid(), file: f.path, side: target.side, start: target.start, end: target.end, code, text, suggestion });
    }
    selection = null;
    rerenderCard(card, f);
    persist();
  };
  form.addEventListener("click", (e) => {
    const a = e.target.closest("[data-f]")?.dataset.f;
    if (a === "cancel") {
      selection = null;
      paintSelection();
      closeForms();
    } else if (a === "save") save();
    else if (a === "ask") {
      toggleAsk(true);
      askPanel.askAbout({ file: f.path, side: target.side, start: target.start, end: target.end, code });
    } else if (a === "sugg") {
      sugg.hidden = !sugg.hidden;
      if (!sugg.hidden && !sugg.value) sugg.value = code;
      if (!sugg.hidden) sugg.focus();
    }
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") {
      selection = null;
      paintSelection();
      closeForms();
    }
  });
  insertAfterRow(card, target.side || "new", target.end, form);
  ta.focus();
}

function commentHtml(a) {
  const where = a.start == null ? "File comment" : a.start === a.end ? `Line ${a.start}` : `Lines ${a.start}–${a.end}`;
  const badge = a.ai ? `<span class="ai-badge ${a.ai.severity}">✦ AI · ${String(a.ai.severity).replace("_", "-")}</span>` : "";
  return `<div class="cmt${a.ai ? " ai" : ""}"><div class="cmt-head"><b>${where}</b>${badge}${a.side === "old" ? "<span>(removed code)</span>" : ""}
    <span class="spacer"></span>
    <button class="icon-btn" data-cmt="edit" data-id="${a.id}">Edit</button>
    <button class="icon-btn" data-cmt="del" data-id="${a.id}" title="Delete">✕</button></div>
    ${a.text ? `<div class="cmt-body">${escapeHtml(a.text)}</div>` : ""}
    ${a.suggestion != null && a.suggestion !== a.code ? `<div class="sugg-label">Suggested change</div><pre>${escapeHtml(a.suggestion)}</pre>` : ""}
    ${a.ai?.reasoning ? `<details><summary>Why Claude flagged this</summary><div class="cmt-body">${escapeHtml(a.ai.reasoning)}</div></details>` : ""}</div>`;
}

function renderThreads(card, f) {
  const anns = state.annotations.filter((a) => a.file === f.path);
  const cols = state.layout === "split" ? 4 : 3;
  const fileLevel = anns.filter((a) => a.start == null);
  if (fileLevel.length) {
    const wrap = h(`<div class="form-wrap-static" style="padding:8px 12px;border-bottom:1px solid var(--border)">${fileLevel.map(commentHtml).join("")}</div>`);
    card.querySelector(".card-body").prepend(wrap);
  }
  for (const a of anns.filter((x) => x.start != null)) {
    const row = findRow(card, a.side, a.end);
    const tr = h(`<table><tr class="thread"><td colspan="${cols}">${commentHtml(a)}</td></tr></table>`).querySelector("tr");
    if (row) {
      let anchor = row;
      while (anchor.nextElementSibling?.classList.contains("thread")) anchor = anchor.nextElementSibling;
      anchor.after(tr);
    } else {
      // Line not in the current diff (e.g. diff type changed): show at top.
      const wrap = h(`<div style="padding:8px 12px">${commentHtml(a)}</div>`);
      card.querySelector(".card-body").prepend(wrap);
    }
  }
}

function rerenderCard(card, f) {
  const fresh = renderCard(f, Number(card.dataset.idx));
  fresh.classList.remove("collapsed");
  fillCard(fresh, f);
  card.replaceWith(fresh);
  renderFileList();
  refreshCounts();
  paintSelection();
}

/* ---------- Ask AI + AI review ---------- */

function setupAI() {
  const ai = payload.ai || { available: false, reason: "Ask AI is unavailable." };
  askPanel = createAskPanel({
    root: $("#askpane"),
    ai,
    getNotes: () =>
      state.annotations
        .map((a) => `- ${a.file ? `${a.file}${a.start != null ? `:${a.start}-${a.end}` : ""}` : "general"}: ${a.text}`)
        .join("\n"),
    describeSelection: (sel) =>
      sel.start == null ? sel.file : `${sel.file}:${sel.start}${sel.end !== sel.start ? `-${sel.end}` : ""}${sel.side === "old" ? " (old)" : ""}`,
    onAddNote: (sel, text) => {
      if (sel?.file) state.annotations.push({ id: uid(), file: sel.file, side: sel.side, start: sel.start, end: sel.end, code: sel.code, text });
      else state.annotations.push({ id: uid(), file: null, text });
      rerenderAll();
      persist();
      toast("Added as a comment");
    },
  });
  if (!ai.available) return;
  $("#asktoggle").hidden = false;
  $("#asktoggle").onclick = () => toggleAsk();
  $("#askclose").onclick = () => toggleAsk(false);
  if (ai.canReview) {
    $("#aireview").hidden = false;
    $("#aireview").onclick = startAIReview;
  }
}

function toggleAsk(open) {
  const side = $("#askside");
  const show = open ?? side.hidden;
  side.hidden = !show;
  $(".layout").classList.toggle("with-ask", show);
  if (show) askPanel.focus();
}

let aiJob = null;

async function startAIReview() {
  if (aiJob) return;
  const banner = $("#aibanner");
  banner.hidden = false;
  banner.innerHTML = `<span class="spark">✦</span> <b>AI review running</b> <span class="act">Starting Claude…</span> <span class="el"></span> <button class="btn small" data-a="cancel">Cancel</button>`;
  $("#aireview").disabled = true;
  try {
    const { id } = await api("/api/ai-review", {});
    aiJob = id;
  } catch (e) {
    banner.innerHTML = `<span class="spark">✦</span> AI review failed to start: ${escapeHtml(e.message)}`;
    $("#aireview").disabled = false;
    return;
  }
  banner.querySelector("[data-a=cancel]").onclick = async () => {
    await api("/api/ai-review-cancel", { id: aiJob }).catch(() => {});
  };
  const poll = async () => {
    let job;
    try {
      job = await api(`/api/ai-review-status?id=${encodeURIComponent(aiJob)}`);
    } catch (e) {
      job = { status: "error", error: e.message };
    }
    if (job.status === "running") {
      banner.querySelector(".act").textContent = job.activity.at(-1) || "Reading the change…";
      banner.querySelector(".el").textContent = `${job.elapsed}s`;
      return setTimeout(poll, 1500);
    }
    aiJob = null;
    $("#aireview").disabled = false;
    if (job.status === "done") {
      const added = addFindings(job.findings);
      const imp = job.findings.filter((f) => f.severity === "important").length;
      banner.innerHTML = `<span class="spark">✦</span> <b>AI review: ${added} finding${added === 1 ? "" : "s"}${imp ? ` (${imp} important)` : ""}.</b> <span>${escapeHtml(job.summary || "")}</span>
        <span class="spacer"></span><button class="icon-btn" data-a="x">✕</button>`;
      banner.querySelector("[data-a=x]").onclick = () => (banner.hidden = true);
      if (added) toast("Findings were added as comments: edit or delete any before sending");
    } else if (job.status === "cancelled") {
      banner.hidden = true;
    } else {
      banner.innerHTML = `<span class="spark">✦</span> AI review failed: ${escapeHtml(job.error || "unknown error")} <span class="spacer"></span><button class="icon-btn" data-a="x">✕</button>`;
      banner.querySelector("[data-a=x]").onclick = () => (banner.hidden = true);
    }
  };
  setTimeout(poll, 1000);
}

/** Map a finding's path onto a file in the diff (agents sometimes add or drop a prefix). */
function matchFile(p) {
  if (!p) return null;
  const clean = p.replace(/^\.?\/+/, "").replace(/^[ab]\//, "");
  return files.find((f) => f.path === clean) || files.find((f) => f.path.endsWith("/" + clean) || clean.endsWith("/" + f.path)) || null;
}

function addFindings(findings) {
  let n = 0;
  for (const f of findings || []) {
    const file = matchFile(f.file);
    const ai = { severity: f.severity, reasoning: f.reasoning };
    if (!file) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : "";
      state.annotations.push({ id: uid(), file: null, text: where + f.description, ai });
    } else if (f.line == null) {
      state.annotations.push({ id: uid(), file: file.path, side: null, start: null, end: null, code: "", text: f.description, ai });
    } else {
      const start = f.line;
      const end = Math.max(start, f.end_line ?? start);
      state.annotations.push({ id: uid(), file: file.path, side: "new", start, end, code: codeFor(file, "new", start, end), text: f.description, ai });
    }
    n++;
  }
  rerenderAll();
  persist();
  return n;
}

function rerenderAll() {
  renderCards();
  renderFileList();
  refreshCounts();
}

/* ---------- general comments ---------- */

function addGeneral() {
  const text = $("#general").value.trim();
  if (!text) return;
  state.annotations.push({ id: uid(), file: null, text });
  $("#general").value = "";
  persist();
}

function renderGeneral() {
  const list = $("#genlist");
  list.innerHTML = "";
  for (const a of state.annotations.filter((x) => !x.file)) {
    const el = h(`<div class="cmt"><button class="icon-btn" title="Delete">✕</button><div class="cmt-body"></div></div>`);
    el.querySelector(".cmt-body").textContent = a.text;
    if (a.ai) el.prepend(h(`<span class="ai-badge ${a.ai.severity}" style="margin-bottom:4px">✦ AI · ${a.ai.severity.replace("_", "-")}</span>`));
    el.querySelector("button").onclick = () => {
      state.annotations = state.annotations.filter((x) => x !== a);
      persist();
    };
    list.append(el);
  }
}

function refreshCounts() {
  $("#n").textContent = state.annotations.length;
  renderGeneral();
}

function persist() {
  refreshCounts();
  saveDraft({ annotations: state.annotations, viewed: state.viewed });
}

/* ---------- decisions ---------- */

function exportable() {
  return state.annotations.map(({ id, ...rest }) => rest);
}

async function sendFeedback() {
  const pendingText = $("#general").value.trim();
  if (pendingText) addGeneral();
  const anns = exportable();
  if (!anns.length) {
    toast("Click a line number to comment, or add a general comment");
    return;
  }
  await decide("annotated", { annotations: anns }, { title: "Feedback sent", detail: `${anns.length} comment${anns.length > 1 ? "s" : ""} sent to Claude.` });
}

async function approve() {
  const anns = exportable();
  if (anns.length) {
    const c = await ask({
      title: "Approve with comments?",
      body: `You have ${anns.length} comment${anns.length > 1 ? "s" : ""}. Approving sends them as optional notes. Send them as required changes instead?`,
      buttons: [
        { label: "Cancel", value: null, cls: "ghost" },
        { label: "Approve with notes", value: "approve" },
        { label: "Send as changes", value: "send", cls: "primary" },
      ],
    });
    if (c === "send") return sendFeedback();
    if (c !== "approve") return;
  }
  await decide("approved", { annotations: anns }, { title: "Approved", detail: "Claude was told the review passed." });
}

async function closeSession() {
  const c = await ask({
    title: "Close without a decision?",
    body: "Claude will be told the review closed without feedback. Your comments stay saved as a draft for next time.",
    buttons: [
      { label: "Cancel", value: null, cls: "ghost" },
      { label: "Close", value: "close", cls: "primary" },
    ],
  });
  if (c === "close") await decide("dismissed", {}, { title: "Closed", detail: "No feedback was sent." });
}
