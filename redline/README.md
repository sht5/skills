# Redline

Browser-based **plan review** and **code review** for Claude Code. Redline is a small, local, zero-dependency alternative to Plannotator. It keeps only two parts: plan review, and the `/review` slash-command skill.

- **Plan review (automatic).** When Claude calls `ExitPlanMode`, the plan opens in your browser. Select any passage to comment on it, replace it, remove it, or add text after it, and leave overall feedback. Then **Approve**, optionally switching the permission mode, or **Request changes**. Claude receives your notes, each with the exact quote it refers to, and must revise the plan. When the revised plan arrives, a **Changes since vN** tab shows what Claude changed.
- **Code review (`/redline-review`).** This opens a diff viewer for your working tree, another worktree, a GitHub PR or a GitLab MR. Click a line number to comment, shift-click to select a range, and use **Suggest change** to propose replacement code. You can also leave file-level and general comments and mark files as viewed. Switch between unified and split views, or change the diff type and base ref without restarting. **Send feedback** gives Claude a structured, per-file and per-line report.

Everything runs on `localhost`. There is no telemetry and nothing leaves your machine, except the `gh`/`glab` calls a PR review makes. Unsent notes are saved as drafts, so a crashed or timed-out session can pick up where it left off.

## Install

Requires Node.js 18 or later.

```bash
# 1. Put the `redline` CLI on your PATH
npm install -g ./redline        # or: cd redline && npm link

# 2. Wire it into Claude Code (adds the ExitPlanMode hook + the two skills to ~/.claude)
redline install                 # --dry-run to preview; `redline uninstall` reverses it
```

Restart Claude Code, or open `/hooks`, so it picks up the hook.

**Or as a Claude Code plugin.** This directory is also a plugin and a single-plugin marketplace. You still need step 1, because the review skill calls `redline` from your PATH.

```
/plugin marketplace add /absolute/path/to/redline
/plugin install redline@redline
```

## Use

| You want | Do |
| --- | --- |
| Review a plan | Use plan mode as usual. When Claude calls `ExitPlanMode`, the browser opens. |
| Review your current changes | `/redline-review` |
| Review another worktree | `/redline-review ../other-worktree` |
| Review a PR / MR | `/redline-review https://github.com/owner/repo/pull/123` (needs `gh auth login`) |
| Review one layer of a stacked branch | `/redline-review --base feature/part-1` |
| Review only staged changes / the last commit | `/redline-review --diff-type staged` / `--diff-type last-commit` |

On the plan page, **Close** gives no decision, and Claude Code falls back to its own terminal prompt. On the review page, **Close** tells Claude "Review session closed without feedback", and Claude stops. Closing the tab without clicking anything does the same after 5 seconds. Reloading the tab is safe.

Keyboard shortcuts: on the plan page, `⌘/Ctrl+Enter` approves and `⌘/Ctrl+Shift+Enter` requests changes. Inside a comment box, `⌘/Ctrl+Enter` saves the comment and `Esc` cancels it.

## CLI

```
redline review [DIR | PR_URL] [--base <ref>] [--diff-type <type>] [--patch-file <path|->] [--json]
redline plan-hook              # the hook entry point (reads hook JSON on stdin)
redline sessions [--open N]    # list / reopen live sessions (e.g. after closing a tab)
redline install | uninstall [--dry-run]
redline data-dir
```

Diff types: `since-base` (the default) shows everything a PR would show, meaning the merge-base with the trunk compared against the working tree, untracked files included. The others are `uncommitted`, `staged`, `unstaged` and `last-commit`.

| Env var | Effect |
| --- | --- |
| `REDLINE_BROWSER=<app>` / `none` | Which browser to open. With `none`, no browser opens and the URL is only printed on stderr. |
| `REDLINE_PORT` | Use a fixed port instead of a random one |
| `REDLINE_REMOTE=1` | Remote mode for SSH and devcontainers: binds `0.0.0.0` on port `19533`. It is detected automatically over SSH, so forward the port. |
| `REDLINE_DATA_DIR` | Where plan history and drafts live. Default `~/.redline`. |

## How it works

```
ExitPlanMode ──► PermissionRequest hook ──► redline plan-hook ──► local HTTP server + browser UI
                                                   │
             {"behavior":"allow", updatedInput, updatedPermissions}   ◄── Approve
             {"behavior":"deny",  message: "YOUR PLAN WAS NOT APPROVED… # Plan Feedback …"}  ◄── Request changes
             (no output → Claude Code's normal prompt)                ◄── Close

/redline-review ──► skill runs  !`redline review $ARGUMENTS`  ──► git diff / gh pr diff ──► browser UI
                                     stdout: "# Code Review Feedback …" ──► Claude acts on it
```

- `bin/redline.js` is the CLI entry point.
- `src/plan.js` is the hook. It reads the plan, keeps a version history per project and session (used for the diff view), and emits the decision.
- `src/review.js` and `src/git.js` build the diffs: merge-base detection, untracked files, PRs and MRs.
- `src/session.js` is the one-shot HTTP server. It handles decisions, drafts, close detection and the session registry.
- `src/feedback.js` holds the exact markdown Claude receives.
- `ui/` is a plain HTML/CSS/JS front end with its own markdown renderer and unified-diff parser. There is no build step.
- `skills/redline` is the reference skill. `skills/redline-review` is the `/redline-review` slash command.
- `hooks/hooks.json` and `.claude-plugin/` hold the plugin packaging.

## Tests

```bash
npm test     # unit tests + end-to-end tests that run the real hook/review processes over HTTP
```
