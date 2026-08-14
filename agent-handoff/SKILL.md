---
name: agent-handoff
description: Summarizes the current conversation into a compact markdown handoff file — goal, decisions made, current state, next steps, and non-obvious context a fresh agent couldn't otherwise guess — and saves it to the system temp folder so a brand-new agent session can resume with a small, curated context instead of the full transcript. Deliberately excludes filler and anything a fresh agent can re-derive by reading the repo itself (full diffs, code already committed, file contents). Always reports the full file path back to the user. Use when the user asks to "hand this off", "start a fresh agent/session with this", "compact this conversation", "continue in a new chat/window", or asks for a handoff/summary doc to resume work elsewhere.
---

# Agent Handoff

Produces one markdown file that lets a *different, context-free* agent pick
up where this conversation left off — without inheriting the full transcript.
The value of this skill is in what it leaves OUT: a fresh agent can read the
repo itself, so don't hand it the repo again in prose form. Hand it the
things it can't get any other way — decisions, rationale, current state, and
traps.

## Step 1 — Extract, don't transcribe

Review the conversation so far and pull out only:

- **Goal** — 1-3 sentences on what the user is actually trying to accomplish,
  stated as the destination, not the journey.
- **Decisions made** — choices that were debated or are non-default: why
  option A was picked over B, naming/structure conventions adopted,
  trade-offs accepted. This is the highest-value section — a fresh agent
  will otherwise re-litigate or silently pick differently.
- **Current state** — what's actually done (files changed, commits made,
  tests run and their result) vs. what's still in progress.
- **Next steps / open questions** — explicit TODOs and anything still
  waiting on the user, stated as actions, not vague pointers.
- **Non-obvious context** — environment quirks, constraints, rejected
  approaches and why, anything the user said that isn't visible in the code
  or repo and that a fresh agent would likely guess wrong or have to ask
  about again.
- **Relevant paths / references** — file paths, PR/issue links, branch
  names. Point at them; don't inline their contents.

Explicitly leave out: the blow-by-blow of how the conversation unfolded,
full code/diffs (the fresh agent will read the repo), anything a fresh
agent can recover by reading the codebase or docs, pleasantries.

If a section would be empty (e.g. no real decisions were made yet), omit
that section rather than padding it.

## Step 2 — Write the file

Every handoff file opens with this fixed preamble, unchanged, before any of
the extracted content — it's what tells the resuming agent what kind of
document this is and how to treat it:

```markdown
# Handoff: <short topic>

> **This is a compacted handoff of a prior conversation, not the original
> conversation.** Treat everything below as the starting context for this
> session. Before taking any action, read it in full, then ask the user how
> they'd like to proceed from here.

_Generated <date>._

## Goal
<1-3 sentences>

## Decisions made
- <decision> — <why, if non-obvious>

## Current state
- <what's done>
- <what's in progress>

## Next steps
- <concrete next action>

## Things a fresh agent won't otherwise know
- <gotcha / constraint / rejected approach / environment quirk>

## Relevant paths / references
- <path or link> — <one-line note on what it is>
```

Determine the temp directory: `${TMPDIR:-/tmp}` on macOS/Linux, `%TEMP%` on
Windows. Filename: `agent-handoff-<slug-of-topic>-<YYYYMMDD-HHMMSS>.md`.
Write the file there.

## Step 3 — Hand back the path

Always end by stating the full absolute path on disk, plainly. If this
session is running somewhere the user's local machine can't reach the
filesystem it wrote to (a remote/cloud session), say so and, if a
file-delivery tool is available in this session, also send the file
directly rather than leaving the user with an unreachable path.
