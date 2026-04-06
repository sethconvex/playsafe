import { parseArgs } from "node:util";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { PR_REQUEST_DIR, ensureDir } from "./utils.mjs";

const USAGE = `
playsafe request — Request a draft PR (used by the agent)

The agent commits locally, then calls this. The watcher pushes the branch
and creates a draft PR using the reviewer's credentials.

Usage:
  playsafe request --repo-path <path> --branch <branch> --title <title> [options]

Options:
  --repo-path  Path to the local git repo
  --branch     Branch name to push and create the PR from
  --base       Base branch (default: main)
  --title      PR title
  --body       PR description
  --wait       Wait for result (default: true)
  --timeout    Seconds to wait for result (default: 120)
  -h, --help   Show this help
`.trim();

export async function requestPr(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "repo-path": { type: "string" },
      branch: { type: "string" },
      base: { type: "string", default: "main" },
      title: { type: "string" },
      body: { type: "string", default: "" },
      wait: { type: "boolean", default: true },
      timeout: { type: "string", default: "120" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (!values["repo-path"] || !values.branch || !values.title) {
    console.error("Error: --repo-path, --branch, and --title are required\n");
    console.log(USAGE);
    process.exit(1);
  }

  ensureDir(PR_REQUEST_DIR);

  const id = `pr-${Date.now()}-${process.pid}`;
  const requestFile = join(PR_REQUEST_DIR, `${id}.json`);
  const resultFile = join(PR_REQUEST_DIR, `${id}.result`);

  const request = {
    id,
    repo_path: resolve(values["repo-path"]),
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

  console.log("Waiting for branch push and draft PR creation...");
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

  console.error("Timed out waiting for PR creation. Is 'playsafe watch' running?");
  process.exit(1);
}
