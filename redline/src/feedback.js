// Turns reviewer annotations into the markdown the agent reads.

export function planDeniedHeader(file) {
  const where = file ? `the plan file (${file})` : "the plan";
  const rerun = file ? `\`redline plan ${file}\`` : "`redline plan` on the revised plan";
  return `YOUR PLAN WAS NOT APPROVED.

You MUST revise ${where} to address ALL of the feedback below, then run ${rerun} again for another review. Do not start implementing.

Rules:
- Do not resubmit the same plan unchanged.
- Keep the plan's title (first # heading) unless the reviewer asks you to change it.
- Quoted text identifies the exact passage each note refers to.`;
}

export const PLAN_APPROVED = "# Plan Approved\n\nThe reviewer approved the plan. Proceed with the implementation.";
export const PLAN_CLOSED = "Plan review closed without a decision. Do not start implementing: ask the user how they want to proceed.";

export const REVIEW_APPROVED = "# Code Review\n\nCode review completed — no changes requested.";

export const REVIEW_DENIED_SUFFIX = `

---
Treat each item above as reviewer input to verify, not as established fact. For every item, check it against the actual code, then either make the change or explain briefly why not (for example: already handled, intended behaviour, out of scope). Apply changes in the reviewed directory.`;

export const REVIEW_CLOSED = "Review session closed without feedback.";

function quoteBlock(text) {
  return String(text ?? "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function fence(text, lang = "") {
  const body = String(text ?? "");
  let ticks = "```";
  while (body.includes(ticks)) ticks += "`";
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function inlineQuote(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 300 ? `"${t.slice(0, 300)}…"` : `"${t}"`;
}

/**
 * @param {Array<{type:string, quote?:string, text?:string, section?:string}>} annotations
 */
export function formatPlanFeedback(annotations = []) {
  const general = annotations.filter((a) => a.type === "general" && a.text?.trim());
  const inline = annotations.filter((a) => a.type !== "general");
  const parts = ["# Plan Feedback", ""];
  if (general.length) {
    parts.push("## Overall", "");
    for (const g of general) parts.push(g.text.trim(), "");
  }
  inline.forEach((a, i) => {
    const where = a.section ? ` (in "${a.section}")` : "";
    const n = i + 1;
    switch (a.type) {
      case "delete":
        parts.push(`## ${n}. Remove this${where}`, "", quoteBlock(a.quote), "");
        if (a.text?.trim()) parts.push(`Reason: ${a.text.trim()}`, "");
        break;
      case "replace":
        parts.push(`## ${n}. Replace this${where}`, "", quoteBlock(a.quote), "", "With:", "", quoteBlock(a.text), "");
        break;
      case "insert":
        parts.push(`## ${n}. Add after this${where}`, "", quoteBlock(a.quote), "", "Add:", "", quoteBlock(a.text), "");
        break;
      default:
        parts.push(`## ${n}. Comment${where}`, "", quoteBlock(a.quote), "", a.text?.trim() || "(no comment)", "");
    }
  });
  return parts.join("\n").trimEnd();
}

export function composePlanDenied(annotations, file) {
  return `${planDeniedHeader(file)}\n\n${formatPlanFeedback(annotations)}`;
}

/** The text printed on stdout for a plan decision. */
export function composePlanMessage(result, file) {
  const anns = (result.annotations || []).filter((a) => a.type !== "general" || a.text?.trim());
  if (result.decision === "approved") {
    if (!anns.length) return { decision: "approved", message: PLAN_APPROVED };
    return {
      decision: "approved",
      message: `# Plan Approved\n\nThe reviewer approved the plan with notes. Proceed with the implementation and follow these notes as you go; you do not need to resubmit the plan.\n\n${formatPlanFeedback(anns).replace(/^# Plan Feedback\n\n/, "")}`,
    };
  }
  if (result.decision === "annotated" && anns.length) {
    return { decision: "annotated", message: composePlanDenied(anns, file) };
  }
  return { decision: "dismissed", message: PLAN_CLOSED };
}

function lineLabel(a) {
  const side = a.side === "old" ? "old" : "new";
  return a.start === a.end || a.end == null ? `Line ${a.start} (${side})` : `Lines ${a.start}-${a.end} (${side})`;
}

function langFor(file) {
  const ext = String(file).split(".").pop().toLowerCase();
  const map = {
    js: "js", mjs: "js", cjs: "js", jsx: "jsx", ts: "ts", tsx: "tsx", py: "python", rb: "ruby",
    go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp",
    cs: "csharp", php: "php", sh: "bash", md: "markdown", json: "json", yml: "yaml", yaml: "yaml",
    css: "css", html: "html", sql: "sql",
  };
  return map[ext] || "";
}

/**
 * @param {Array<{file?:string|null, side?:string, start?:number, end?:number, code?:string, text:string, suggestion?:string}>} annotations
 * @param {{describe?:string, mr?:{title:string,url:string,number:number,head:string,base:string,repo:string}}} ctx
 */
export function formatReviewFeedback(annotations = [], ctx = {}) {
  const out = [];
  if (ctx.mr) {
    out.push(`# MR Review: ${ctx.mr.repo}!${ctx.mr.number}`, "", `**${ctx.mr.title}**`);
    out.push(`Branch: \`${ctx.mr.head}\` → \`${ctx.mr.base}\``, ctx.mr.url, "");
  } else {
    out.push("# Code Review Feedback", "");
    if (ctx.describe) out.push(`**Diff:** ${ctx.describe}`, "");
  }
  const general = annotations.filter((a) => !a.file && a.text?.trim());
  const placed = annotations.filter((a) => a.file);
  if (general.length) {
    out.push("## General", "");
    for (const g of general) {
      out.push(g.ai ? `${g.text.trim()} _(AI finding, ${g.ai.severity})_` : g.text.trim(), "");
      if (g.ai?.reasoning?.trim()) out.push(`Reasoning: ${g.ai.reasoning.trim()}`, "");
    }
  }
  const byFile = new Map();
  for (const a of placed) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }
  for (const [file, list] of byFile) {
    out.push(`## ${file}`, "");
    list.sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
    for (const a of list) {
      const tag = a.ai ? ` — AI finding (${String(a.ai.severity || "finding").replace("_", "-")})` : "";
      if (a.start == null) {
        out.push(`### File comment${tag}`, "");
      } else {
        out.push(`### ${lineLabel(a)}${tag}`, "");
        if (a.code) out.push(fence(a.code, langFor(file)), "");
      }
      if (a.text?.trim()) out.push(a.text.trim(), "");
      if (a.ai?.reasoning?.trim()) out.push(`Reasoning: ${a.ai.reasoning.trim()}`, "");
      if (a.suggestion != null && a.suggestion !== a.code) {
        out.push("Suggested change:", "", fence(a.suggestion, langFor(file)), "");
      }
    }
  }
  return out.join("\n").trimEnd();
}

/** The text printed on stdout for a review decision. */
export function composeReviewMessage(result, ctx) {
  const anns = result.annotations || [];
  const hasContent = anns.some((a) => a.text?.trim() || (a.suggestion != null && a.suggestion !== a.code));
  if (result.decision === "dismissed") return { decision: "dismissed", message: REVIEW_CLOSED };
  if (result.decision === "approved") {
    if (!hasContent) return { decision: "approved", message: REVIEW_APPROVED };
    return {
      decision: "approved",
      message: `# Code Review\n\nApproved with notes. The notes below are suggestions, not required changes.\n\n${formatReviewFeedback(anns, ctx)}`,
    };
  }
  if (!hasContent) return { decision: "approved", message: REVIEW_APPROVED };
  return { decision: "annotated", message: formatReviewFeedback(anns, ctx) + REVIEW_DENIED_SUFFIX };
}
