# Redline

Browser-based **plan review** and **code review** for **Claude Code**, with **Ask AI** built in. Redline is a small, local alternative to Plannotator, with no npm dependencies. It keeps only plan review and code review, supports Claude Code only, works with GitLab (through `glab`) for merge requests, and **uses no hooks**: everything runs through skills that call the `redline` CLI.

- **Plan review (`/redline-plan`).** Claude writes its plan to a markdown file and runs `redline plan <file>`, which opens the plan in your browser. Claude also uses this skill on its own when you ask it to plan first. Select any passage to comment on it, replace it, remove it, add text after it, or **ask Claude about it**. Then choose one of three outcomes:
  - **Approve**: Claude implements the plan.
  - **Approve with notes**: Claude implements the plan and follows your notes.
  - **Request changes**: Claude revises the same file and asks for review again. A **Changes since vN** tab shows what it changed.
- **Code review (`/redline-review`).** This opens a diff viewer for your working tree, another worktree, or a **GitLab merge request** on gitlab.com or a self-hosted instance. Click a line number to comment, shift-click to select a range, and use **Suggest change** to propose replacement code. You can also leave file-level and general comments, mark files as viewed, switch between unified and split views, and change the diff type and base ref without restarting. **Send feedback** gives Claude a structured, per-file and per-line report.
- **Ask AI (both pages).** A chat panel answers questions about the plan or diff, or about the passage or lines you selected, while you review. Answers stream in and support follow-ups, and you can turn an answer into a note with one click.
  - **This session** forks the Claude Code session that opened the review, so Claude answers with the whole conversation in mind. Your own session is left untouched.
  - **Fresh** starts a new conversation that sees only what is under review.
  - Claude gets read-only tools here (Read, Glob, Grep, web search, read-only `git` and `glab mr view/diff`). It can never edit files from the review UI.
- **AI review (code review page).** This runs a Claude review agent over the change. Its findings appear as comments marked **✦ AI · important / nit / pre-existing**, with the reasoning attached. Edit or delete any of them, then send the ones you agree with.

Everything runs on `localhost`, and there is no telemetry. Only two things reach the network: `glab` calls for an MR review, and Claude requests when you use Ask AI or AI review. Unsent notes are saved as drafts, so a crashed or timed-out session can pick up where it left off.

## Install

Requires Node.js 18 or later and Claude Code (the `claude` CLI powers Ask AI). For MR reviews you also need [`glab`](https://gitlab.com/gitlab-org/cli), logged in with `glab auth login` (add `--hostname <host>` for a self-hosted GitLab).

```bash
# 1. Put the `redline` CLI on your PATH
npm install -g ./redline        # or: cd redline && npm link

# 2. Add the skills to Claude Code (copies them to ~/.claude/skills; no hooks, no settings changes)
redline install                 # --dry-run to preview; `redline uninstall` reverses it
```

Start a new Claude Code session so it picks up the skills. If you installed Redline 0.1, `redline install` also removes the plan hook that version added to `settings.json`.

**Or as a Claude Code plugin.** This directory is also a plugin and a single-plugin marketplace. You still need step 1, because the review skill calls `redline` from your PATH.

```
/plugin marketplace add /absolute/path/to/redline
/plugin install redline@redline
```

## Use

| You want | Do |
| --- | --- |
| Plan first, then implement | `/redline-plan add rate limiting to the API`, or ask Claude to "plan it in Redline first" |
| Review a plan file you already have | `/redline-plan docs/plan.md` |
| Review your current changes | `/redline-review` |
| Review another worktree | `/redline-review ../other-worktree` |
| Review a GitLab MR | `/redline-review https://gitlab.com/group/project/-/merge_requests/42` |
| Review one layer of a stacked branch | `/redline-review --base feature/part-1` |
| Review only staged changes / the last commit | `/redline-review --diff-type staged` / `--diff-type last-commit` |
| Ask Claude about part of a plan | Select the text, then choose **✦ Ask AI** |
| Ask Claude about some lines of code | Click a line number (shift-click for a range), then choose **✦ Ask AI**. Or open **✦ Ask AI** in the top bar. |
| Have Claude review the diff first | **✦ AI review** in the top bar |

**Close** on either page tells Claude the review ended without a decision. On the plan page Claude then asks you how to proceed, and on the review page Claude stops. Neither counts as an approval. Closing the tab without clicking anything does the same after 5 seconds. Reloading the tab is safe.

Keyboard shortcuts:

- Plan page: `⌘/Ctrl+Enter` approves and `⌘/Ctrl+Shift+Enter` requests changes.
- Comment boxes: `⌘/Ctrl+Enter` saves and `Esc` cancels.
- Ask AI: `Enter` sends and `Shift+Enter` starts a new line.

## CLI

```
redline review [DIR | MR_URL] [--base <ref>] [--diff-type <type>] [--patch-file <path|->] [--json]
redline plan <PLAN_FILE | -> [--json]   # review a markdown plan; decision on stdout
redline sessions [--open N]    # list / reopen live sessions (e.g. after closing a tab)
redline install | uninstall [--dry-run]
redline data-dir
```

Diff types: `since-base` (the default) shows everything a merge request would show, meaning the merge-base with the trunk compared against the working tree, untracked files included. The others are `uncommitted`, `staged`, `unstaged` and `last-commit`.

| Env var | Effect |
| --- | --- |
| `REDLINE_AI=disabled` | Turn off Ask AI and AI review |
| `REDLINE_AI_MODEL` | Default Ask AI model. Default `sonnet`, and it can be changed in the panel. |
| `REDLINE_REVIEW_MODEL` | AI review agent model. Default `opus`. |
| `REDLINE_BROWSER=<app>` / `none` | Which browser to open. With `none`, no browser opens and the URL is only printed on stderr. |
| `REDLINE_PORT` | Use a fixed port instead of a random one |
| `REDLINE_REMOTE=1` | Remote mode for SSH and devcontainers: binds `0.0.0.0` on port `19533`. It is detected automatically over SSH, so forward the port. |
| `REDLINE_DATA_DIR` | Where plan history and drafts live. Default `~/.redline`. |

## How it works

```
/redline-plan ──► Claude writes .redline/plans/<name>.md ──► runs `redline plan <file>` (background, long timeout)
                     stdout: "# Plan Approved …" ──► Claude implements (following any notes)
                             "YOUR PLAN WAS NOT APPROVED … # Plan Feedback …" ──► Claude edits the file and reruns
                             "Plan review closed without a decision." ──► Claude asks you

/redline-review ──► skill runs  !`redline review $ARGUMENTS`  ──► git diff / glab mr diff ──► browser UI
                     stdout: "# Code Review Feedback …" ──► Claude acts on it

Ask AI ──► POST /api/ask ──► claude -p --output-format stream-json --permission-mode dontAsk (read-only tools)
             "This session": --resume <session> --fork-session  (follow-ups: --resume <fork>)
             answer streams back to the panel as NDJSON
AI review ──► claude -p --json-schema {findings…} --no-session-persistence ──► comments in the diff
```

**Which session does "This session" fork?**

- Claude Code runs `redline plan` and `redline review` itself, so Redline walks up its parent processes to the Claude Code process and reads that process's entry in `~/.claude/sessions/<pid>.json`.
- If no session is found, only **Fresh** is offered.
- Forked asks run in that session's directory, so `--resume` can find it.

Redline registers no hooks and changes no Claude Code settings. Its `claude` children are ordinary `claude -p` runs, so your own hooks and settings apply to them as usual.

| Path | What it holds |
| --- | --- |
| `bin/redline.js` | The CLI entry point |
| `src/plan.js` | `redline plan`. It keeps a version history per project and plan file, which the diff view uses. |
| `src/review.js`, `src/git.js` | Diff building: merge-base detection, untracked files, GitLab MRs through `glab` |
| `src/claude.js` | The `claude -p` bridge: stream parsing, session discovery, read-only tool policy |
| `src/ai.js` | Ask AI and AI review endpoints, and their prompts |
| `src/session.js` | The one-shot HTTP server: decisions, drafts, streaming, close detection |
| `src/feedback.js` | The exact markdown Claude receives |
| `ui/` | Plain HTML/CSS/JS with no build step, including a markdown renderer, a unified-diff parser and the Ask AI panel |
| `skills/redline` | The reference skill |
| `skills/redline-plan` | The `/redline-plan` workflow (write the plan, run `redline plan`, act on the decision) |
| `skills/redline-review` | The `/redline-review` slash command |
| `.claude-plugin/` | Plugin packaging (skills only) |

## Tests

```bash
npm test   # unit + end-to-end tests; fake `claude` and `glab` executables stand in for the real CLIs
```
