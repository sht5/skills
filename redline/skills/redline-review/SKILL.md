---
name: redline-review
description: Open Redline's browser code review for the current changes, another directory, or a GitLab merge request URL, then act on the feedback that comes back.
argument-hint: "[directory | GitLab MR URL] [--base <ref>] [--diff-type <type>]"
allowed-tools: Bash(redline:*)
disable-model-invocation: true
---

# Redline Review

Arguments pass straight through to `redline review`: one directory or GitLab merge request URL, plus `--base <ref>` and `--diff-type <since-base|uncommitted|staged|unstaged|last-commit>` (git only). To review one layer of a stacked branch, pass `--base <the branch below yours>`.

## Code review feedback

!`redline review $ARGUMENTS`

## Your task

Read the review output above and respond according to what it says:

- **Feedback** (starts with `# Code Review Feedback` or `# MR Review:`): work through every item in the same conversation. Each comment names a file and line range, quotes the code it refers to, and may include a suggested change. Items marked `AI finding (...)` came from Redline's AI review agent; the reviewer kept them, but verify them as carefully as any other item. Check each item against the actual code first. Then make the change, or explain in one line why you did not (already handled, intended behaviour, out of scope). Apply changes in the directory the review names. When you finish, summarise what you changed per item.
- **Approved** (`Code review completed — no changes requested.`): say the review passed and continue with what you were doing.
- **Approved with notes**: the notes are optional suggestions. Apply the ones that are clearly right, and mention the ones you skipped.
- **Closed** (`Review session closed without feedback.`, or empty output): say so in one sentence and stop. Do not start any work, because closing the review is not an approval.
- **An error** (for example `Not a git repository` or `glab mr view failed`): report it and suggest the fix, such as a correct path or `glab auth login --hostname <host>`. Do not retry with guessed arguments.
