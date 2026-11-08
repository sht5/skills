import { $, $$, api, ask, decide, draftSaver, escapeHtml, h, setupTheme, toast, uid, watchClose } from "./common.js";
import { createAskPanel } from "./ask.js";
import { renderMarkdown } from "./markdown.js";

const KINDS = {
  comment: { label: "Comment", verb: "Comment" },
  replace: { label: "Replace", verb: "Replace with" },
  delete: { label: "Remove", verb: "Why remove it? (optional)" },
  insert: { label: "Add after", verb: "Text to add after this" },
};

const state = { annotations: [], general: "", view: "doc" };
const ranges = new Map(); // annotation id -> Range
let payload;
const saveDraft = draftSaver();
const doc = $("#doc");
const hasHighlights = typeof CSS !== "undefined" && "highlights" in CSS;
let askPanel;

init().catch((e) => {
  doc.innerHTML = `<p>Failed to load: ${escapeHtml(e.message)}</p>`;
});

async function init() {
  payload = await api("/api/payload");
  setupTheme($("#theme"));
  watchClose();
  document.title = `${payload.title} · Plan Review`;
  $("#crumb").innerHTML = `<strong>${escapeHtml(payload.title)}</strong> · ${escapeHtml(payload.project || "")}`;
  if (payload.version) {
    $("#version").hidden = false;
    $("#version").textContent = `v${payload.version}`;
  }
  if (payload.diff) {
    $("#viewseg").hidden = false;
    const changed = payload.diff.filter((d) => d.op !== " ").length;
    $("#diffbtn").textContent = `Changes since v${payload.previousVersion} (${changed})`;
    $$("#viewseg button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  }
  try {
    const m = localStorage.getItem("redline-mode");
    if (m) $("#mode").value = m;
  } catch {}
  $("#mode").onchange = () => {
    try {
      localStorage.setItem("redline-mode", $("#mode").value);
    } catch {}
  };

  doc.innerHTML = renderMarkdown(payload.plan);
  $$(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  askPanel = createAskPanel({
    root: $("#askpane"),
    ai: payload.ai || { available: false, reason: "Ask AI is unavailable." },
    getNotes: notesSummary,
    describeSelection: (sel) => `“${sel.quote.replace(/\s+/g, " ").slice(0, 90)}${sel.quote.length > 90 ? "…" : ""}”`,
    onAddNote: (sel, text) => {
      if (sel) {
        const a = { id: uid(), type: "comment", quote: sel.quote, text, line: sel.line, section: sel.section };
        state.annotations.push(a);
        const r = findRange(a.quote, a.line);
        if (r) ranges.set(a.id, r);
      } else {
        state.general = (state.general ? state.general + "\n\n" : "") + text;
        $("#general").value = state.general;
      }
      refresh();
      toast(sel ? "Added as a note" : "Added to overall feedback");
    },
  });
  if (payload.draft) {
    state.general = payload.draft.general || "";
    for (const a of payload.draft.annotations || []) {
      const r = findRange(a.quote, a.line);
      if (r) ranges.set(a.id, r);
      state.annotations.push(a);
    }
    if (state.annotations.length || state.general) toast("Restored your unsent notes");
  }
  $("#general").value = state.general;
  $("#general").addEventListener("input", (e) => {
    state.general = e.target.value;
    refresh();
  });

  doc.addEventListener("mouseup", onSelect);
  doc.addEventListener("keyup", (e) => e.shiftKey && onSelect());
  doc.addEventListener("click", onDocClick);
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".selbar, .composer")) closePopups();
  });
  document.addEventListener("keydown", onKey);
  $("#approve").onclick = approve;
  $("#deny").onclick = requestChanges;
  $("#close").onclick = closeSession;
  refresh();
}

function showTab(t) {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== t));
  if (t === "ask") askPanel?.focus();
}

/** The reviewer's notes so far, as context for Ask AI. */
function notesSummary() {
  const lines = state.annotations.map((a, i) => `${i + 1}. ${a.type} on "${a.quote.slice(0, 200)}"${a.text ? `: ${a.text}` : ""}`);
  if (state.general.trim()) lines.unshift(`Overall: ${state.general.trim()}`);
  return lines.join("\n");
}

function setView(v) {
  state.view = v;
  $$("#viewseg button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  closePopups();
  if (v === "diff") {
    doc.classList.remove("md");
    doc.innerHTML = renderDiff(payload.diff);
  } else {
    doc.classList.add("md");
    doc.innerHTML = renderMarkdown(payload.plan);
    ranges.clear();
    for (const a of state.annotations) {
      const r = findRange(a.quote, a.line);
      if (r) ranges.set(a.id, r);
    }
  }
  paint();
}

function renderDiff(diff) {
  // Show changed lines with 3 lines of context; collapse the rest.
  const keep = new Array(diff.length).fill(false);
  diff.forEach((d, i) => {
    if (d.op !== " ") for (let k = Math.max(0, i - 3); k <= Math.min(diff.length - 1, i + 3); k++) keep[k] = true;
  });
  let out = "";
  let skipped = 0;
  diff.forEach((d, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    if (skipped) out += `<div class="gap">⋯ ${skipped} unchanged line${skipped > 1 ? "s" : ""}</div>`;
    skipped = 0;
    const cls = d.op === "+" ? "add" : d.op === "-" ? "del" : "";
    out += `<div class="${cls}">${escapeHtml(d.text) || " "}</div>`;
  });
  if (skipped) out += `<div class="gap">⋯ ${skipped} unchanged line${skipped > 1 ? "s" : ""}</div>`;
  if (!diff.some((d) => d.op !== " ")) out = `<div class="gap">No changes since the previous version.</div>`;
  return `<div class="diffview">${out}</div>`;
}

/* ---------- selection → annotation ---------- */

let pending = null; // { range, quote, line, section }

function onSelect() {
  if (state.view !== "doc") return;
  setTimeout(() => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!doc.contains(range.commonAncestorContainer)) return;
    const quote = sel.toString().trim();
    if (!quote) return;
    pending = { range: range.cloneRange(), quote, ...locate(range) };
    showSelbar(range);
  }, 0);
}

function locate(range) {
  let node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const block = node.closest("[data-line]");
  const line = block ? Number(block.dataset.line) : null;
  // Nearest heading at or before the selection.
  let section = null;
  const heads = $$("h1,h2,h3,h4,h5,h6", doc);
  for (const hd of heads) {
    const pos = hd.compareDocumentPosition(node);
    if (hd === node || hd.contains(node) || pos & Node.DOCUMENT_POSITION_FOLLOWING) section = hd.textContent.trim();
  }
  return { line, section };
}

function closePopups() {
  $$(".selbar, .composer").forEach((e) => e.remove());
}

function placeNear(el, rect, below = true) {
  document.body.append(el);
  const w = el.offsetWidth;
  const left = Math.min(Math.max(8, rect.left + window.scrollX + rect.width / 2 - w / 2), window.scrollX + innerWidth - w - 8);
  const top = below ? rect.bottom + window.scrollY + 8 : rect.top + window.scrollY - el.offsetHeight - 8;
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(window.scrollY + 60, top)}px`;
}

function showSelbar(range) {
  closePopups();
  const bar = h(`<div class="selbar" role="toolbar">
    <button class="btn" data-k="comment">💬 Comment</button>
    <button class="btn" data-k="replace">✎ Replace</button>
    <button class="btn" data-k="delete">⌫ Remove</button>
    <button class="btn" data-k="insert">＋ Add after</button>
    ${payload.ai?.available ? `<button class="btn" data-k="ask"><span class="spark">✦</span> Ask AI</button>` : ""}</div>`);
  bar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  bar.addEventListener("click", (e) => {
    const k = e.target.closest("button")?.dataset.k;
    if (k === "ask") {
      const sel = { quote: pending.quote, section: pending.section, line: pending.line };
      closePopups();
      getSelection()?.removeAllRanges();
      showTab("ask");
      askPanel.askAbout(sel);
    } else if (k) openComposer(k);
  });
  placeNear(bar, range.getBoundingClientRect(), false);
}

function openComposer(kind, existing) {
  const target = existing || pending;
  if (!target) return;
  const range = existing ? ranges.get(existing.id) : pending.range;
  closePopups();
  const c = h(`<div class="composer">
    <div class="label"><span>${KINDS[kind].verb}</span><span class="kbd">⌘/Ctrl+Enter</span></div>
    <textarea class="input" rows="4"></textarea>
    <div class="row"><button class="btn ghost small" data-a="cancel">Cancel</button><button class="btn primary small" data-a="save">${existing ? "Update" : "Add note"}</button></div></div>`);
  const ta = c.querySelector("textarea");
  ta.value = existing ? existing.text || "" : kind === "replace" ? target.quote : "";
  const save = () => {
    const text = ta.value;
    if (kind !== "delete" && !text.trim()) {
      ta.focus();
      return;
    }
    if (existing) {
      existing.text = text;
    } else {
      const a = { id: uid(), type: kind, quote: pending.quote, text, line: pending.line, section: pending.section };
      state.annotations.push(a);
      ranges.set(a.id, pending.range);
      getSelection()?.removeAllRanges();
      pending = null;
    }
    closePopups();
    refresh();
  };
  c.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (a === "cancel") closePopups();
    if (a === "save") save();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      save();
    }
    if (e.key === "Escape") closePopups();
  });
  const rect = range ? range.getBoundingClientRect() : doc.getBoundingClientRect();
  placeNear(c, rect, true);
  ta.focus();
  ta.select();
}

function onDocClick(e) {
  if (!getSelection().isCollapsed) return;
  const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const node = pos ? pos.offsetNode : document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer;
  const offset = pos ? pos.offset : document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset;
  if (!node) return;
  for (const a of state.annotations) {
    const r = ranges.get(a.id);
    try {
      if (r && r.isPointInRange(node, offset)) return activate(a.id, true);
    } catch {}
  }
}

/* ---------- re-anchoring a quote in the rendered doc ---------- */

function findRange(quote, line) {
  const needle = String(quote || "").replace(/\s+/g, "");
  if (!needle) return null;
  const chars = []; // [node, offset] for each non-whitespace char
  let hay = "";
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const t = n.nodeValue;
    for (let i = 0; i < t.length; i++) {
      if (!/\s/.test(t[i])) {
        chars.push([n, i]);
        hay += t[i];
      }
    }
  }
  let best = -1;
  let bestDist = Infinity;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const el = chars[i][0].parentElement.closest("[data-line]");
    const dist = line && el ? Math.abs(Number(el.dataset.line) - line) : 0;
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  if (best < 0) return null;
  const r = document.createRange();
  const [sn, so] = chars[best];
  const [en, eo] = chars[best + needle.length - 1];
  r.setStart(sn, so);
  r.setEnd(en, eo + 1);
  return r;
}

/* ---------- rendering state ---------- */

let activeId = null;

function paint() {
  if (!hasHighlights) return;
  const normal = [];
  const del = [];
  const act = [];
  if (state.view === "doc") {
    for (const a of state.annotations) {
      const r = ranges.get(a.id);
      if (!r) continue;
      (a.id === activeId ? act : a.type === "delete" ? del : normal).push(r);
    }
  }
  CSS.highlights.set("rl-ann", new Highlight(...normal));
  CSS.highlights.set("rl-del", new Highlight(...del));
  CSS.highlights.set("rl-active", new Highlight(...act));
}

function activate(id, scroll) {
  activeId = id;
  paint();
  $$(".note").forEach((n) => n.classList.toggle("active", n.dataset.id === id));
  if (scroll) $(`.note[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function refresh() {
  const list = $("#notes");
  list.innerHTML = "";
  if (!state.annotations.length) list.append(h(`<div class="empty">No notes yet.</div>`));
  state.annotations.forEach((a, i) => {
    const el = h(`<div class="note" data-id="${a.id}">
      <div class="note-head"><span class="note-kind">${i + 1}. ${KINDS[a.type].label}</span>
        ${a.section ? `<span>· ${escapeHtml(a.section)}</span>` : ""}
        <span class="note-actions"><button class="icon-btn" data-a="edit" title="Edit">Edit</button><button class="icon-btn" data-a="del" title="Delete">✕</button></span></div>
      <div class="note-quote">${escapeHtml(a.quote)}</div>
      ${a.text ? `<div class="note-body">${a.type === "replace" ? "→ " : ""}${escapeHtml(a.text)}</div>` : ""}
      ${ranges.has(a.id) ? "" : `<div class="note-head" style="margin:4px 0 0">(text no longer found in the plan)</div>`}</div>`);
    el.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.a;
      if (act === "del") {
        state.annotations = state.annotations.filter((x) => x !== a);
        ranges.delete(a.id);
        return refresh();
      }
      if (act === "edit") {
        if (state.view !== "doc") setView("doc");
        return openComposer(a.type, a);
      }
      activate(a.id);
      const r = ranges.get(a.id);
      if (r) {
        const rect = r.getBoundingClientRect();
        window.scrollTo({ top: window.scrollY + rect.top - innerHeight / 3, behavior: "smooth" });
      }
    });
    list.append(el);
  });
  const n = state.annotations.length + (state.general.trim() ? 1 : 0);
  $("#n").textContent = n;
  $("#n2").textContent = n;
  paint();
  saveDraft({ annotations: state.annotations, general: state.general });
}

/* ---------- decisions ---------- */

function allAnnotations() {
  const out = state.annotations.map(({ id, ...rest }) => rest);
  if (state.general.trim()) out.unshift({ type: "general", text: state.general.trim() });
  return out;
}

async function approve() {
  const n = allAnnotations().length;
  if (n) {
    const choice = await ask({
      title: "Approve with notes?",
      body: `You have ${n} note${n > 1 ? "s" : ""}. Approving lets Claude start right away and does not send them. Send them as a change request instead?`,
      buttons: [
        { label: "Cancel", value: null, cls: "ghost" },
        { label: "Approve anyway", value: "approve" },
        { label: "Request changes", value: "deny", cls: "primary" },
      ],
    });
    if (choice === "deny") return requestChanges();
    if (choice !== "approve") return;
  }
  const mode = $("#mode").value;
  await decide("approved", { permissionMode: mode }, { title: "Plan approved", detail: "Claude is continuing with the plan." });
}

async function requestChanges() {
  const anns = allAnnotations();
  if (!anns.length) {
    toast("Add a note or overall feedback first");
    $("#general").focus();
    return;
  }
  await decide("annotated", { annotations: anns }, { title: "Feedback sent", detail: `${anns.length} note${anns.length > 1 ? "s" : ""} sent to Claude. It will revise the plan.` });
}

async function closeSession() {
  const choice = await ask({
    title: "Close without deciding?",
    body: "Claude Code will fall back to its own approval prompt in the terminal. Your notes stay saved as a draft.",
    buttons: [
      { label: "Cancel", value: null, cls: "ghost" },
      { label: "Close", value: "close", cls: "primary" },
    ],
  });
  if (choice === "close") await decide("dismissed", {}, { title: "Closed", detail: "Answer the prompt in your terminal." });
}

function onKey(e) {
  if (e.target.closest?.(".composer")) return;
  if (e.key === "Escape") return closePopups();
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (e.shiftKey || e.target.id === "general") requestChanges();
    else approve();
  }
}
