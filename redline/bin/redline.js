#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));

const USAGE = `redline ${pkg.version}: browser plan review and code review for Claude Code

Usage:
  redline review [DIR | MR_URL] [--base <ref>] [--diff-type <type>] [--json]
                                 Review code changes in the browser; feedback on stdout
  redline plan <PLAN_FILE> [--json]
                                 Review a markdown plan in the browser; decision on stdout
  redline sessions [--clean]     List live review sessions
  redline install [--dry-run]    Add the skills to ~/.claude/skills
  redline uninstall [--dry-run]  Remove them
  redline data-dir               Print the data directory (plan history, drafts)
  redline --version

Environment:
  REDLINE_BROWSER=<app>|none     Browser to open (none: just print the URL on stderr)
  REDLINE_PORT=<n>               Fixed port instead of a random one
  REDLINE_REMOTE=1|0             Remote mode (SSH/devcontainer): bind 0.0.0.0, port 19533
  REDLINE_DATA_DIR=<dir>         Where plan history and drafts live (default ~/.redline)
  REDLINE_AI=disabled            Turn off Ask AI and the AI review agent
  REDLINE_AI_MODEL=<model>       Default Ask AI model (default sonnet)
  REDLINE_REVIEW_MODEL=<model>   AI review agent model (default opus)

MR_URL is a GitLab merge request (gitlab.com or self-hosted), fetched with glab.
`;

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "review": {
      const { review } = await import("../src/review.js");
      return review(args);
    }
    case "plan": {
      const { planCommand } = await import("../src/plan.js");
      return planCommand(args);
    }
    case "sessions": {
      const { sessions } = await import("../src/sessions.js");
      return sessions(args);
    }
    case "install":
    case "uninstall": {
      const mod = await import("../src/install.js");
      process.stdout.write(mod[cmd]({ dryRun: args.includes("--dry-run") }) + "\n");
      return;
    }
    case "data-dir": {
      const { dataDir } = await import("../src/util.js");
      process.stdout.write(dataDir() + "\n");
      return;
    }
    case "-v":
    case "--version":
      process.stdout.write(pkg.version + "\n");
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`redline: unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`redline: ${e?.stack || e}\n`);
  process.exit(1);
});
