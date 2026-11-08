// Small, dependency-free GitHub-flavoured markdown renderer.
// Supports: ATX headings, paragraphs, (nested) ordered/unordered/task lists,
// fenced code, blockquotes, tables, horizontal rules, and inline code,
// bold, italic, strikethrough, links and autolinks. Raw HTML is escaped.

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHref(href) {
  const h = href.trim();
  if (/^(https?:|mailto:|#|\/|\.\.?\/)/i.test(h) || !/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  return "#";
}

export function renderInline(text) {
  const codes = [];
  // Protect code spans first so nothing inside them is formatted.
  let s = String(text).replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => {
    codes.push(`<code>${escapeHtml(code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1"))}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => `<img alt="${alt}" src="${escapeHtml(safeHref(src))}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, href) => `<a href="${escapeHtml(safeHref(href))}" target="_blank" rel="noopener">${label}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  s = s.replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^\s_](?:[\s\S]*?[^\s_])?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^\s_](?:[^_]*?[^\s_])?)_(?![_\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const RE = {
  fence: /^(\s{0,3})(`{3,}|~{3,})\s*([\w+-]*)?.*$/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>\s?(.*)$/,
  list: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
};

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Render markdown to HTML. Every top-level block carries data-line (1-based
 * source line) so the UI can relate selections back to the source.
 */
export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const slugs = new Map();
  return renderBlocks(lines, 0, slugs);
}

function renderBlocks(lines, offset, slugs) {
  const out = [];
  let i = 0;
  const at = (n) => ` data-line="${offset + n + 1}"`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = line.match(RE.fence))) {
      const marker = m[2];
      const lang = m[3] || "";
      const start = i;
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence
      out.push(
        `<div class="code-block"${at(start)}>${lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ""}<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(body.join("\n"))}</code></pre></div>`,
      );
      continue;
    }
    if ((m = line.match(RE.heading))) {
      const level = m[1].length;
      const html = renderInline(m[2]);
      let id = slugify(html) || "section";
      const n = slugs.get(id) || 0;
      slugs.set(id, n + 1);
      if (n) id += `-${n}`;
      out.push(`<h${level} id="${id}"${at(i)}>${html}</h${level}>`);
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      out.push(`<hr${at(i)}>`);
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const start = i;
      const body = [];
      while (i < lines.length && lines[i].trim() && (m = lines[i].match(RE.quote))) {
        body.push(m[1]);
        i++;
      }
      out.push(`<blockquote${at(start)}>${renderBlocks(body, offset + start, slugs)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const start = i;
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${renderInline(c)}</${tag}>`;
      out.push(
        `<div class="table-wrap"${at(start)}><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if ((m = line.match(RE.list))) {
      const start = i;
      const res = renderList(lines, i, offset, slugs);
      i = res.next;
      out.push(res.html.replace(/^<(ul|ol)/, `<$1${at(start)}`));
      continue;
    }
    // Paragraph: gather until a blank line or another block starts.
    const start = i;
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !RE.fence.test(lines[i]) &&
      !RE.heading.test(lines[i]) &&
      !RE.hr.test(lines[i]) &&
      !RE.quote.test(lines[i]) &&
      !(para.length && RE.list.test(lines[i]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p${at(start)}>${renderInline(para.join("\n")).replace(/\n/g, " ")}</p>`);
  }
  return out.join("\n");
}

function renderList(lines, i, offset, slugs) {
  const first = lines[i].match(RE.list);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  while (i < lines.length) {
    const m = lines[i].match(RE.list);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) {
      // Blank lines between items are allowed.
      if (!lines[i].trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const n = j < lines.length && lines[j].match(RE.list);
        if (n && n[1].length === indent && /\d/.test(n[2]) === ordered) {
          i = j;
          continue;
        }
      }
      break;
    }
    const itemLine = i;
    const body = [m[3]];
    i++;
    // Continuation lines and nested blocks: anything indented deeper than the marker.
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        const next = lines.slice(i + 1).find((x) => x.trim());
        if (next && next.match(/^(\s*)/)[1].length > indent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const lead = l.match(/^(\s*)/)[1].length;
      if (lead <= indent && (RE.list.test(l) || lead === 0)) {
        if (lead === 0 && !RE.list.test(l) && !RE.heading.test(l) && !RE.fence.test(l) && body.length === 1 && !RE.quote.test(l) && !RE.hr.test(l)) {
          body.push(l.trim()); // lazy continuation
          i++;
          continue;
        }
        break;
      }
      body.push(l.slice(Math.min(lead, indent + 2)));
      i++;
    }
    let text = body[0];
    let task = null;
    const t = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (t) {
      task = t[1] !== " ";
      text = t[2];
    }
    const restLines = body.slice(1);
    const firstPara = [text];
    while (restLines.length && restLines[0].trim() && !RE.list.test(restLines[0]) && !RE.fence.test(restLines[0])) {
      firstPara.push(restLines.shift().trim());
    }
    const nested = restLines.length ? renderBlocks(restLines, offset + itemLine + 1, slugs) : "";
    const box = task == null ? "" : `<input type="checkbox" disabled${task ? " checked" : ""}> `;
    items.push(
      `<li${task != null ? ' class="task"' : ""} data-line="${offset + itemLine + 1}">${box}${renderInline(firstPara.join(" "))}${nested}</li>`,
    );
  }
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return { html: `<${tag}${startAttr}>${items.join("")}</${tag}>`, next: i };
}
