---
name: redline
description: "Reference for Redline, the local browser-based review layer for plans and code in Claude Code: how plan review on ExitPlanMode works and how to read its feedback, how to run `redline review` (local changes, another directory, a GitLab merge request, a patch file) with the right flags, how its Ask AI and AI review features relate to you, and how to interpret its output. Use when the user asks to review code or a plan in Redline, asks for a browser or visual review, or when you need to choose `redline` commands or flags yourself."
---

# Redline

Redline opens plans and diffs in a local browser UI. The human marks them up, and their structured feedback comes back to you: through the plan hook's decision, or on the stdout of `redline review`. Everything stays on this machine. A session serves on a random `localhost` port (fixed port 19533 in remote mode) and blocks until the reviewer approves, sends feedback or closes the tab.

The `redline-review` skill (`/redline-review`) is the thin launcher for code review. Use this reference when you need to pick commands or flags yourself.

## Choose the command

| The user wants | Do this |
| --- | --- |
| Review a plan you wrote | Nothing. Write the plan and call `ExitPlanMode`: the Redline hook opens it in the browser automatically. Never run `redline plan-hook` yourself. |
| Review the current code changes | `redline review` |
| Review another repo or worktree | `redline review ../other-worktree` |
| Review a GitLab merge request | `redline review <MR_URL>` (needs an authenticated `glab`; gitlab.com or self-hosted) |
| Review only one layer of a stacked branch | `redline review --base <branch-below>` |
| Review only staged / unstaged / the last commit | `redline review --diff-type staged` (or `unstaged`, `last-commit`, `uncommitted`) |
| Review a diff that is not in a repository | `redline review --patch-file changes.diff` (`-` reads stdin) |
| Find a review tab that was closed | `redline sessions`, then `redline sessions --open N` |

## Plan review (automatic)

When you call `ExitPlanMode`, the `PermissionRequest` hook runs `redline plan-hook`. The reviewer reads the rendered plan and selects passages to comment on, replace, remove, or add text after. They can also leave overall feedback, and compare the plan with its previous version. Then:

- **Approved**: the tool call is allowed and you proceed. The reviewer may also change the permission mode, for example to auto-accept edits.
- **Changes requested**: the tool call is denied with a message that starts `YOUR PLAN WAS NOT APPROVED.` and is followed by `# Plan Feedback`. Each numbered item quotes the exact passage and says what to do: **Comment**, **Replace this … With:**, **Remove this**, or **Add after this … Add:**. Revise the plan to address every item. Keep the title unless asked otherwise. Do not resubmit it unchanged. Then call `ExitPlanMode` again. The reviewer sees a diff against the version they reviewed.
- **Closed**: nothing comes back from Redline, and Claude Code shows its normal approval prompt instead.

## `redline review`

```bash
redline review [--base <ref>] [--diff-type <type>] [--patch-file <path|->] [--json] [DIRECTORY | MR_URL]
```

- Default diff (`since-base`): everything a merge request would show now, meaning the merge-base with the trunk compared against the working tree, untracked files included. The trunk is `origin/HEAD`, then `main`/`master` (local or `origin/`). With no trunk (for example a repo with no remote) it falls back to `uncommitted`.
- `--base` and `--diff-type` only set the starting view. The reviewer can switch either in the UI. Both are git-only. A `--base` that does not resolve is a startup error that names similar branches.
- A directory selects which repository to review. It is not a file filter. Paths resolve from the current directory, so quote any that contain spaces.
- It takes one target at most. `--patch-file` cannot be combined with a target, `--base` or `--diff-type`.
- An MR URL looks like `https://<host>/<group>/<project>/-/merge_requests/<iid>`. GitHub pull request URLs are refused: Redline only talks to GitLab, through `glab`.

### Running it

The command blocks until the human decides, which can take many minutes. Run it in the foreground with a long timeout, or in the background with `run_in_background` and `timeout: 7200000`, then read stdout when it exits. Never kill it to "finish" the review: a session that ends without a decision reads as no feedback. If a time limit stopped it, run the same command again, and the reviewer's unsent comments are restored from the draft.

### Output (stdout)

| Outcome | Plain text | `--json` `decision` |
| --- | --- | --- |
| Approved | `# Code Review` … `Code review completed — no changes requested.` | `approved` |
| Approved with notes | `# Code Review` … `Approved with notes.` followed by the comments | `approved` |
| Feedback | `# Code Review Feedback` (or `# MR Review: group/project!N`), then `## <file>` and `### Line N (new)` / `### Lines A-B (old)` sections, each with the quoted code, the comment and an optional `Suggested change:` block. A `## General` section holds comments on the whole change. | `annotated` |
| Closed | `Review session closed without feedback.` | `dismissed` |

With `--json` the output is a single record: `{"decision": "...", "message": "<the plain-text output>"}`. Decide what happened from `decision`, never by matching the message text.

How to act on each outcome:

- `(new)` line numbers refer to the file as it is now. `(old)` refers to removed code.
- Feedback items are reviewer input, so verify each one against the code before you change anything.
- Notes on an approval are optional suggestions, not required changes.
- A closed review is not an approval. Do not start work because of one.

Startup errors go to stderr with exit code 1 (bad target, not a git repo, `glab` failed) or 2 (bad flags).

## Ask AI and the AI review agent

Both review pages have **Ask AI**: the reviewer asks Claude questions about the plan or diff (or a selected passage or line range) without leaving the browser. It runs `claude -p` with read-only tools (Read, Glob, Grep, web search, read-only `git` and `glab mr view|diff`); it can never edit files.

- **This session** forks the Claude Code session that opened the review (`--resume <id> --fork-session`), so the answer knows your conversation. The fork is a copy: nothing is added to your own session, and you will not see those questions.
- **Fresh** starts a new conversation that only sees the plan or diff.
- The code review page also has **AI review**: a Claude review agent whose findings become ordinary comments the reviewer can edit or delete before sending. Kept findings reach you labelled `AI finding (important | nit | pre-existing)` with a `Reasoning:` line.

An answer the reviewer liked can be turned into a note, so you may receive feedback that Claude wrote. Treat it exactly like the reviewer's own notes: they chose to send it.

## Environment variables

| Variable | Effect |
| --- | --- |
| `REDLINE_BROWSER=<app>` / `none` | Which browser to open. With `none`, no browser opens and the URL is only printed on stderr. |
| `REDLINE_PORT=<n>` | Use a fixed port instead of a random one |
| `REDLINE_REMOTE=1` / `0` | Force remote mode on or off. Remote mode binds 0.0.0.0 on port 19533 for SSH and devcontainers, and is detected automatically over SSH. |
| `REDLINE_DATA_DIR` | Where plan history and drafts live. Default `~/.redline`. `redline data-dir` prints it. |
| `REDLINE_AI=disabled` | Turn off Ask AI and the AI review agent |
| `REDLINE_AI_MODEL` / `REDLINE_REVIEW_MODEL` | Default model for Ask AI (`sonnet`) and for the review agent (`opus`) |

## Do not

- Do not run `redline plan-hook` interactively. It is the hook entry point and reads hook JSON on stdin.
- Do not scrape the browser UI. The hook decision and stdout are the whole contract.
- Do not guess flags. Run `redline review --help` when unsure, because unknown flags fail on purpose.
- Do not start a review when no human is there to answer it, because it blocks until someone decides.
