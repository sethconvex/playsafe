#!/usr/bin/env node

import { setup } from "../src/setup.mjs";
import { run } from "../src/run.mjs";
import { watch } from "../src/watch.mjs";
import { requestPr } from "../src/request-pr.mjs";
import { serve } from "../src/serve.mjs";
import { uninstall } from "../src/uninstall.mjs";

const USAGE = `
agent-sandbox — Run AI coding agents safely with an isolated user and draft-PR workflow

Usage:
  agent-sandbox setup     Configure the sandbox (interactive, opens browser for PATs)
  agent-sandbox watch     Start the draft PR watcher (runs as your user)
  agent-sandbox run       Run a coding agent in the sandbox
  agent-sandbox request   Request a draft PR (CLI, called by the agent)
  agent-sandbox serve     Start the MCP server (agents call create_draft_pr as a tool)
  agent-sandbox uninstall Remove the sandbox and watcher service

Options:
  -h, --help     Show this help
  -v, --version  Show version
`.trim();

const command = process.argv[2];

if (!command || command === "-h" || command === "--help") {
  console.log(USAGE);
  process.exit(0);
}

if (command === "-v" || command === "--version") {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const dir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

const subArgv = process.argv.slice(3);

const commands = { setup, watch, run, request: requestPr, serve, uninstall };

if (!commands[command]) {
  console.error(`Unknown command: ${command}\n`);
  console.log(USAGE);
  process.exit(1);
}

try {
  await commands[command](subArgv);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
