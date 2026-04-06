import { parseArgs } from "node:util";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  AGENT_USER, SANDBOX_DIR, PR_REQUEST_DIR, PLIST_NAME,
  exec, isRoot, userExists, loadConfig,
} from "./utils.mjs";

const USAGE = `
agent-sandbox uninstall — Remove the sandbox and watcher service

Usage:
  agent-sandbox uninstall

Options:
  -h, --help  Show this help
`.trim();

export async function uninstall(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const osUserMode = config?.mode === "os-user";

  // Stop watcher
  console.log("Stopping PR watcher...");
  const uid = exec("id -u");
  try { exec(`launchctl bootout gui/${uid}/${PLIST_NAME}`); } catch {}
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${PLIST_NAME}.plist`);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log("  Watcher removed.");

  // Remove OS user if applicable
  if (osUserMode && userExists(AGENT_USER)) {
    if (!isRoot()) {
      console.error(`Note: OS user '${AGENT_USER}' exists but needs sudo to delete.`);
      console.error("  Run: sudo agent-sandbox uninstall");
    } else {
      console.log(`Deleting macOS user '${AGENT_USER}'...`);
      exec(`sysadminctl -deleteUser ${AGENT_USER}`);
      console.log("  User deleted.");
    }
  }

  // Remove sandbox directory
  if (existsSync(SANDBOX_DIR)) {
    console.log(`Removing ${SANDBOX_DIR}...`);
    rmSync(SANDBOX_DIR, { recursive: true });
    console.log("  Sandbox removed.");
  }

  // Cleanup
  if (existsSync(PR_REQUEST_DIR)) rmSync(PR_REQUEST_DIR, { recursive: true });
  const logDir = join(homedir(), "Library", "Logs", "agent-sandbox");
  if (existsSync(logDir)) rmSync(logDir, { recursive: true });

  console.log("\nUninstall complete.");
}
