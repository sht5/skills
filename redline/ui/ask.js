// Ask AI chat panel, backed by `claude -p` through /api/ask (NDJSON stream).
import { $, api, escapeHtml, h, toast, uid } from "./common.js";
import { renderMarkdown } from "./markdown.js";

const MODELS = ["sonnet", "opus", "haiku"];

/**
 * @param {object} o
 * @param {HTMLElement} o.root          element to render the panel into
 * @param {object} o.ai                 payload.ai from the server
 * @param {() => string} o.getNotes     current review notes, as context for the first question
 * @param {(sel:object, text:string) => void} [o.onAddNote]  turn an answer into a note
 * @param {(sel:object) => string} o.describeSelection       short label for a selection chip
 */
export function createAskPanel({ root, ai, getNotes, onAddNote, describeSelection }) {
  const state = {
    mode: ai.defaultMode || "fresh",
    model: load("redline-ask-model") || ai.askModel || "sonnet",
    conversationId: null,
    conversationMode: null,
    selection: null,
    busy: null, // askId while streaming
  };

  root.innerHTML = "";
  if (!ai.available) {
    root.append(h(`<div class="ask"><div class="empty">${escapeHtml(ai.reason || "Ask AI is unavailable.")}</div></div>`));
    return { askAbout() {}, focus() {} };
  }

  const el = h(`<div class="ask">
    <div class="ask-bar">
      <div class="seg small" role="group" aria-label="Who answers">
        <button data-mode="session" title="${ai.sessionAvailable ? "Fork the Claude Code session that opened this review: it knows the whole conversation" : "No Claude Code session was found for this review"}"${ai.sessionAvailable ? "" : " disabled"}>This session</button>
        <button data-mode="fresh" title="A new Claude conversation that only sees what is under review">Fresh</button>
      </div>
      <select class="input small-input" aria-label="Model">${MODELS.map((m) => `<option>${m}</option>`).join("")}</select>
      <span class="spacer"></span>
      <button class="btn ghost small" data-act="new" title="Start a new conversation">New chat</button>
    </div>
    <div class="ask-thread" aria-live="polite"><div class="ask-hello">Ask anything about what you are reviewing. Select text${ai.canReview ? " or lines" : ""} first to ask about it specifically. Claude can read the repository but cannot change anything.</div></div>
    <div class="ask-compose">
      <div class="ask-chip" hidden><span class="ask-chip-text"></span><button class="icon-btn" data-act="clear-sel" title="Remove">✕</button></div>
      <textarea class="input" rows="3" placeholder="Ask Claude… (Enter to send, Shift+Enter for a new line)"></textarea>
      <div class="ask-row"><span class="ask-status"></span><span class="spacer"></span>
        <button class="btn small" data-act="stop" hidden>Stop</button>
        <button class="btn primary small" data-act="send">Ask</button></div>
    </div></div>`);
  root.append(el);
  const thread = $(".ask-thread", el);
  const ta = $("textarea", el);
  const modelSel = $("select", el);
  modelSel.value = MODELS.includes(state.model) ? state.model : "sonnet";

  const paintMode = () => {
    el.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
  };
  paintMode();

  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mode && !b.disabled) {
      if (state.conversationId && b.dataset.mode !== state.conversationMode) newChat();
      state.mode = b.dataset.mode;
      paintMode();
    }
    const act = b.dataset.act;
    if (act === "send") send();
    if (act === "stop") stop();
    if (act === "new") newChat();
    if (act === "clear-sel") setSelection(null);
  });
  modelSel.onchange = () => {
    state.model = modelSel.value;
    save("redline-ask-model", state.model);
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  function setSelection(sel) {
    state.selection = sel;
    const chip = $(".ask-chip", el);
    chip.hidden = !sel;
    if (sel) $(".ask-chip-text", el).textContent = describeSelection(sel);
  }

  function newChat() {
    if (state.busy) stop();
    state.conversationId = null;
    state.conversationMode = null;
    thread.innerHTML = `<div class="ask-hello">New conversation.</div>`;
  }

  function status(t) {
    $(".ask-status", el).textContent = t || "";
  }

  async function send() {
    const question = ta.value.trim();
    if (!question || state.busy) return;
    const askId = uid();
    state.busy = askId;
    const selection = state.selection;
    ta.value = "";
    setSelection(null);
    $(".ask-hello", thread)?.remove();
    const q = h(`<div class="ask-msg user"></div>`);
    if (selection) q.append(h(`<div class="ask-quote">${escapeHtml(describeSelection(selection))}</div>`));
    q.append(document.createTextNode(question));
    thread.append(q);
    const a = h(`<div class="ask-msg ai"><div class="ask-tools"></div><div class="md ask-text"><span class="ask-caret"></span></div></div>`);
    thread.append(a);
    thread.scrollTop = thread.scrollHeight;
    $("[data-act=stop]", el).hidden = false;
    $("[data-act=send]", el).disabled = true;
    const firstTurn = !state.conversationId;
    status(firstTurn && state.mode === "session" ? "Forking your Claude Code session…" : "Thinking…");

    let text = "";
    let failed = null;
    const render = () => {
      $(".ask-text", a).innerHTML = renderMarkdown(text) + (state.busy === askId ? `<span class="ask-caret"></span>` : "");
      const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
      if (near) thread.scrollTop = thread.scrollHeight;
    };
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          askId,
          question,
          selection,
          mode: firstTurn ? state.mode : state.conversationMode,
          conversationMode: state.conversationMode,
          conversationId: state.conversationId,
          model: state.model,
          notes: firstTurn ? getNotes() : undefined,
        }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "text") {
            text += ev.text;
            status("");
            render();
          } else if (ev.type === "tool") {
            $(".ask-tools", a).append(h(`<div class="ask-tool">↳ ${escapeHtml(ev.name)} <span>${escapeHtml(ev.detail || "")}</span></div>`));
            status(`${ev.name}…`);
          } else if (ev.type === "done") {
            if (!state.conversationId) state.conversationMode = firstTurn ? state.mode : state.conversationMode;
            state.conversationId = ev.conversationId || state.conversationId;
            if (!text && ev.text) text = ev.text;
          } else if (ev.type === "error") {
            failed = ev.error;
            if (ev.conversationId && !state.conversationId) {
              state.conversationId = ev.conversationId;
              state.conversationMode = state.mode;
            }
          }
        }
      }
    } catch (e) {
      failed = e.message;
    }
    state.busy = null;
    render();
    status("");
    $("[data-act=stop]", el).hidden = true;
    $("[data-act=send]", el).disabled = false;
    if (failed) a.append(h(`<div class="ask-error">${escapeHtml(failed)}</div>`));
    if (text) {
      const actions = h(`<div class="ask-actions"></div>`);
      const copy = h(`<button class="icon-btn">Copy</button>`);
      copy.onclick = () => navigator.clipboard?.writeText(text).then(() => toast("Copied"));
      actions.append(copy);
      if (onAddNote) {
        const add = h(`<button class="icon-btn">${selection ? "Add as note on selection" : "Add as note"}</button>`);
        add.onclick = () => {
          onAddNote(selection, text);
          add.disabled = true;
          add.textContent = "Added";
        };
        actions.append(add);
      }
      a.append(actions);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function stop() {
    if (!state.busy) return;
    api("/api/ask-cancel", { askId: state.busy }).catch(() => {});
  }

  return {
    /** Attach a selection and focus the question box. */
    askAbout(sel) {
      setSelection(sel);
      ta.focus();
    },
    focus() {
      ta.focus();
    },
  };
}

function load(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function save(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}
