---
name: redline-plan
description: "Get the user's approval for an implementation plan in Redline's browser review before you implement it. Write the plan to a markdown file, run `redline plan <file>`, and act on the decision that comes back (approve, change requests, or closed). Use when the user asks you to plan first, to review or approve a plan in Redline or in the browser, or when they invoke /redline-plan."
argument-hint: "[what to plan | path to an existing plan file]"
allowed-tools: Bash(redline plan:*)
---

# Redline Plan Review

Redline uses no hooks, so plan review only happens when you run it yourself. The user reads your plan in the browser and can comment on, replace or remove any passage, ask Claude questions about it, and then approve or request changes. Their decision comes back on the command's stdout.

## 1. Write the plan to a file

- Investigate first: read the code you need, so the plan is concrete. Do not change any project files before the plan is approved.
- Write the plan as markdown to `.redline/plans/<short-kebab-name>.md` in the project root, unless the user named a file. If they passed an existing plan file as the argument, review that file instead.
- Start with a `# Title`. Then cover the context, the concrete steps (files and functions you will touch), how you will verify the work, and the risks or open questions.
- Keep the file for the whole review. Every revision goes into the same file, so the reviewer can see what changed between versions.

## 2. Run the review

Run it with the Bash tool, **in the background with a long timeout**, because the reviewer may take a while:

```
redline plan .redline/plans/<name>.md
```

Use `run_in_background: true` and `timeout: 7200000`, then wait for the command to finish before you go on. Do not poll it, kill it, or start implementing while it runs. If it was stopped at the time limit before the user decided, tell the user, and only run it again when they ask; their unsent notes are restored from a draft.

Run it outside Claude Code's built-in plan mode (Shift+Tab cycles modes). In plan mode, the command may be blocked or need permission.

## 3. Act on the result

| Output starts with | What to do |
| --- | --- |
| `# Plan Approved` | Implement the plan. If it lists notes ("approved the plan with notes"), follow them as you go. You do not need another review. |
| `YOUR PLAN WAS NOT APPROVED.` | Do not implement. Revise the **same file** to address every item under `# Plan Feedback` (each one quotes the passage it refers to), then run `redline plan` on it again. Repeat until it is approved. |
| `Plan review closed without a decision.` | Do not implement. Ask the user how they want to proceed. |
| An error on stderr | Report it. A missing file or empty plan means you should fix the file and retry. If `redline` is not found, tell the user to install it (`npm install -g <path-to-redline>`). |

Feedback items are the user's own words, or answers from Ask AI that they chose to keep as notes. Treat all of them as the user's requests.
