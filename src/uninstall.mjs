import { parseArgs } from "node:util";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  AGENT_USER, AGENT_HOME, SANDBOX_DIR, PR_REQUEST_DIR, PLIST_NAME,
  exec, execLive, isRoot, userExists,
} from "./utils.mjs";

const USAGE = `
playsafe uninstall — Remove the sandbox user and watcher service

Usage:
  playsafe uninstall

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

  // Need root to delete the user
  if (userExists(AGENT_USER) && !isRoot()) {
    await execLive("sudo", [process.execPath, ...process.argv.slice(1)]);
    return;
  }

  // Stop watcher
  console.log("Stopping PR watcher...");
  const realUser = process.env.SUDO_USER || process.env.USER;
  const realHome = process.env.SUDO_USER ? `/Users/${realUser}` : homedir();
  try {
    const uid = exec(`id -u ${realUser}`);
    exec(`launchctl bootout gui/${uid}/${PLIST_NAME}`);
  } catch {}
  const plistPath = join(realHome, "Library", "LaunchAgents", `${PLIST_NAME}.plist`);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log("  Watcher removed.");

  // Delete sandbox user
  if (userExists(AGENT_USER)) {
    console.log(`Deleting macOS user '${AGENT_USER}'...`);
    exec(`sysadminctl -deleteUser ${AGENT_USER}`);
    console.log("  User deleted.");
  }

  // Remove sandbox user's home directory (sysadminctl doesn't always clean it)
  if (existsSync(AGENT_HOME)) {
    rmSync(AGENT_HOME, { recursive: true, force: true });
  }

  // Remove sandbox config directory
  if (existsSync(SANDBOX_DIR)) {
    rmSync(SANDBOX_DIR, { recursive: true });
    console.log("  Sandbox config removed.");
  }

  // Cleanup
  if (existsSync(PR_REQUEST_DIR)) rmSync(PR_REQUEST_DIR, { recursive: true });
  const logDir = join(realHome, "Library", "Logs", "playsafe");
  if (existsSync(logDir)) rmSync(logDir, { recursive: true });

  console.log("\nUninstall complete.");
}
