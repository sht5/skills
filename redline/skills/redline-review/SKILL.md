---
name: redline-review
description: Open Redline's browser code review for the current changes, another directory, or a GitHub PR / GitLab MR URL, then act on the feedback that comes back.
argument-hint: "[directory | PR URL] [--base <ref>] [--diff-type <type>]"
allowed-tools: Bash(redline:*)
disable-model-invocation: true
---

# Redline Review

Arguments pass straight through to `redline review`: one directory or PR/MR URL, plus `--base <ref>` and `--diff-type <since-base|uncommitted|staged|unstaged|last-commit>` (git only). To review one layer of a stacked branch, pass `--base <the branch below yours>`.

## Code review feedback

!`redline review $ARGUMENTS`

## Your task

Read the review output above and respond according to what it says:

- **Feedback** (starts with `# Code Review Feedback` or `# PR Review:`): work through every item in the same conversation. Each comment names a file and line range, quotes the code it refers to, and may include a suggested change. Check each item against the actual code first. Then make the change, or explain in one line why you did not (already handled, intended behaviour, out of scope). Apply changes in the directory the review names. When you finish, summarise what you changed per item.
- **Approved** (`Code review completed — no changes requested.`): say the review passed and continue with what you were doing.
- **Approved with notes**: the notes are optional suggestions. Apply the ones that are clearly right, and mention the ones you skipped.
- **Closed** (`Review session closed without feedback.`, or empty output): say so in one sentence and stop. Do not start any work, because closing the review is not an approval.
- **An error** (for example `Not a git repository` or `gh pr view failed`): report it and suggest the fix, such as a correct path or `gh auth login`. Do not retry with guessed arguments.
