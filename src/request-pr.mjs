import { parseArgs } from "node:util";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PR_REQUEST_DIR, ensureDir } from "./utils.mjs";

const USAGE = `
agent-sandbox request — Request a draft PR (used by the agent)

Writes a request to the watched directory. The watcher (running as the
privileged user) picks it up and creates a draft PR.

Usage:
  agent-sandbox request --repo <owner/repo> --branch <branch> --title <title> [options]

Options:
  --repo      GitHub repo (owner/repo format)
  --branch    Branch to create the PR from
  --base      Base branch (default: main)
  --title     PR title
  --body      PR description
  --wait      Wait for result (default: true)
  --timeout   Seconds to wait for result (default: 60)
  -h, --help  Show this help
`.trim();

export async function requestPr(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      branch: { type: "string" },
      base: { type: "string", default: "main" },
      title: { type: "string" },
      body: { type: "string", default: "" },
      wait: { type: "boolean", default: true },
      timeout: { type: "string", default: "60" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (!values.repo || !values.branch || !values.title) {
    console.error("Error: --repo, --branch, and --title are required\n");
    console.log(USAGE);
    process.exit(1);
  }

  ensureDir(PR_REQUEST_DIR);

  const id = `pr-${Date.now()}-${process.pid}`;
  const requestFile = join(PR_REQUEST_DIR, `${id}.json`);
  const resultFile = join(PR_REQUEST_DIR, `${id}.result`);

  const request = {
    id,
    repo: values.repo,
    branch: values.branch,
    base: values.base,
    title: values.title,
    body: values.body,
    requested_by: process.env.USER || "unknown",
    requested_at: new Date().toISOString(),
  };

  writeFileSync(requestFile, JSON.stringify(request, null, 2));
  console.log(`PR request submitted: ${id}`);

  if (!values.wait) return;

  console.log("Waiting for draft PR to be created...");
  const timeoutMs = parseInt(values.timeout) * 1000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (existsSync(resultFile)) {
      const result = JSON.parse(readFileSync(resultFile, "utf8"));
      unlinkSync(resultFile);
      if (result.status === "success") {
        console.log(`Draft PR created: ${result.pr_url}`);
      } else {
        console.error(`PR creation failed: ${result.error}`);
        process.exit(1);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.error("Timed out waiting for PR creation. Is 'agent-sandbox watch' running?");
  process.exit(1);
}
