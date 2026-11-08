#!/usr/bin/env node
// Stand-in for `glab mr view|diff <iid> -R <project-url> ...`.
const [cmd, sub, iid, , repo] = process.argv.slice(2);
if (cmd !== "mr" || !repo) {
  process.stderr.write("unexpected args\n");
  process.exit(1);
}
if (iid === "404") {
  process.stderr.write("404 Not Found\n");
  process.exit(1);
}
if (sub === "view") {
  process.stdout.write(JSON.stringify({ iid: Number(iid), title: "Add limiter", web_url: `${repo}/-/merge_requests/${iid}`, source_branch: "feat/limit", target_branch: "main" }));
} else if (sub === "diff") {
  process.stdout.write("diff --git a/lib/x.rb b/lib/x.rb\n--- a/lib/x.rb\n+++ b/lib/x.rb\n@@ -1 +1 @@\n-old\n+new\n");
} else process.exit(1);
