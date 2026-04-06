#!/usr/bin/env node

import { clone } from "../src/clone.mjs";
import { watch } from "../src/watch.mjs";
import { requestPr } from "../src/request-pr.mjs";
import { serve } from "../src/serve.mjs";
import { uninstall } from "../src/uninstall.mjs";
import { AGENT_USER, userExists, execLive, exec, PR_REQUEST_DIR, ensureDir } from "../src/utils.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, basename, resolve } from "node:path";
import { openSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const USAGE = `
playsafe — Run AI coding agents safely in a sandboxed macOS user

Usage:
  playsafe <repo-url>          Clone, setup, and enter sandbox in one step
  playsafe                     Enter sandbox in current dir
  playsafe <cmd> [args...]     Run a command as the sandbox user
  playsafe uninstall           Remove the sandbox user and all config

Options:
  -h, --help  Show this help
  -v, --version

Examples:
  playsafe https://github.com/owner/repo
  playsafe clone https://github.com/owner/repo && cd repo && playsafe
  playsafe claude --dangerously-skip-permissions
`.trim();

const command = process.argv[2];

// --version
if (command === "-v" || command === "--version") {
  const dir = dirname(fileURLToPath(import.meta.url));
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(joinPath(dir, "..", "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

// --help
if (command === "-h" || command === "--help") {
  console.log(USAGE);
  process.exit(0);
}

// Named subcommands
const subcommands = { clone, watch, request: requestPr, serve, uninstall };
if (command && subcommands[command]) {
  try {
    await subcommands[command](process.argv.slice(3));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// Detect repo URL — clone + cd + enter sandbox in one step
function isRepoUrl(str) {
  return str && (
    str.startsWith("https://") ||
    str.startsWith("http://") ||
    str.startsWith("git@") ||
    str.match(/^[\w-]+\/[\w.-]+$/)  // owner/repo shorthand
  );
}

if (command && isRepoUrl(command)) {
  const repoUrl = command.match(/^[\w-]+\/[\w.-]+$/)
    ? `https://github.com/${command}`
    : command;
  const repoName = basename(repoUrl, ".git");
  const repoDir = resolve(repoName);

  // Clone (handles setup, PAT, etc.)
  try {
    await clone([repoUrl]);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  // Now enter the sandbox in the cloned dir
  process.chdir(repoDir);
  // Fall through to the sandbox entry below
}

// Default: become the sandbox user in the current directory
if (!userExists(AGENT_USER)) {
  console.error(`Sandbox user '${AGENT_USER}' not found.`);
  console.error("Run 'playsafe <repo-url>' to get started.");
  process.exit(1);
}

// Check gh auth before starting
try {
  exec("gh auth status");
} catch {
  console.error("Warning: gh CLI is not authenticated. Run 'gh auth login' first.");
  console.error("Without it, push/PR creation will fail.\n");
}

// Start the watcher in the background
ensureDir(PR_REQUEST_DIR);
const cliDir = dirname(fileURLToPath(import.meta.url));
const logDir = joinPath(homedir(), "Library", "Logs", "playsafe");
ensureDir(logDir);
const logFile = joinPath(logDir, "watcher.log");
let logFd;
try {
  logFd = openSync(logFile, "a");
} catch {
  // Log file may be owned by root from a previous sudo run
  try { unlinkSync(logFile); } catch {}
  try {
    logFd = openSync(logFile, "a");
  } catch {
    // Give up on logging, send to /dev/null
    logFd = openSync("/dev/null", "a");
  }
}
const watcherProc = spawn(process.execPath, [joinPath(cliDir, "cli.mjs"), "watch"], {
  stdio: ["ignore", logFd, logFd],
  detached: false,
});
watcherProc.unref();

// Pass through any remaining args as a command, or drop into a shell
// If we just cloned, remaining will have the repo URL — filter it out
const remaining = (command && isRepoUrl(command))
  ? process.argv.slice(3)
  : process.argv.slice(2);

// Colors
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bgGreen = (s) => `\x1b[42m\x1b[30m${s}\x1b[0m`;

try {
  if (remaining.length > 0) {
    console.log(`${bgGreen(" PLAYSAFE ")} Running ${bold(remaining[0])} as ${cyan(AGENT_USER)}`);
    console.log(dim(`  git push → draft PR  |  branches → playsafe/*  |  read-only PAT`));
    console.log();
    await execLive("sudo", ["-u", AGENT_USER, "-H", ...remaining], {
      cwd: process.cwd(),
    });
  } else {
    console.log();
    console.log(`${bgGreen(" PLAYSAFE ")} ${bold(basename(process.cwd()))}`);
    console.log();
    console.log(`  ${green("user")}     ${AGENT_USER} ${dim("(isolated macOS user)")}`);
    console.log(`  ${green("git")}      read-only ${dim("— pushes become draft PRs")}`);
    console.log(`  ${green("branches")} playsafe/* ${dim("— auto-prefixed")}`);
    console.log();
    console.log(dim(`  Type 'exit' or Ctrl+D to leave the sandbox.`));
    console.log();
    // Use zsh with the sandbox user's .zshenv (has PATH to git wrapper + umask)
    // Set a custom prompt via PROMPT env var
    await execLive("sudo", [
      "-u", AGENT_USER, "-H",
      "/bin/zsh", "-i",
    ], {
      cwd: process.cwd(),
      env: {
        TERM: process.env.TERM || "xterm-256color",
        HOME: `/Users/${AGENT_USER}`,
        ZDOTDIR: `/Users/${AGENT_USER}`,
        PATH: process.env.PATH,
      },
    });
  }
} catch (err) {
  // agent exited with non-zero, that's ok
}

// Clean up watcher and exit immediately
try { watcherProc.kill(); } catch {}
console.log(dim("\nSandbox closed."));
process.exit(0);
