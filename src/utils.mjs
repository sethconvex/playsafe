import { execSync, spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// OS-user isolation (opt-in with --os-user)
export const AGENT_USER = "playsafe-user";
export const AGENT_HOME = `/Users/${AGENT_USER}`;

// Directory-based isolation (default, no sudo)
export const SANDBOX_DIR = join(homedir(), ".playsafe");
export const SANDBOX_WORKSPACE = join(SANDBOX_DIR, "workspace");
export const SANDBOX_GIT_DIR = join(SANDBOX_DIR, "git");

export const PR_REQUEST_DIR = "/tmp/playsafe-pr-requests";
export const PLIST_NAME = "com.playsafe.pr-watcher";

export const CONFIG_FILE = join(SANDBOX_DIR, "config.json");

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
}

export function execLive(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export function isRoot() {
  return process.getuid?.() === 0;
}

export function userExists(username) {
  try {
    exec(`id ${username}`);
    return true;
  } catch {
    return false;
  }
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

export function isOsUserMode() {
  const config = loadConfig();
  return config?.mode === "os-user";
}
