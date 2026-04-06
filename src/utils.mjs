import { execSync, spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const HOST_HOME = process.env.SUDO_USER ? `/Users/${process.env.SUDO_USER}` : homedir();

// OS-user isolation (opt-in with --os-user)
export const AGENT_USER = "playsafe-user";
export const AGENT_HOME = `/Users/${AGENT_USER}`;

// Directory-based isolation (default, no sudo)
export const SANDBOX_DIR = join(HOST_HOME, ".playsafe");
export const SANDBOX_WORKSPACE = join(SANDBOX_DIR, "workspace");
export const SANDBOX_GIT_DIR = join(SANDBOX_DIR, "git");
export const STAGING_REMOTE_DIR = join(SANDBOX_DIR, "staging-remotes");
export const WATCH_STATE_FILE = join(SANDBOX_DIR, "watch-state.json");
export const PLIST_NAME = "com.playsafe.pr-watcher";

export const CONFIG_FILE = join(SANDBOX_DIR, "config.json");

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
}

export function execFile(cmd, args = [], opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
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
    execFile("id", [username]);
    return true;
  } catch {
    return false;
  }
}

export function getUserIds(username) {
  return {
    uid: parseInt(execFile("id", ["-u", username]), 10),
    gid: parseInt(execFile("id", ["-g", username]), 10),
  };
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

export function saveConfig(config) {
  ensureDir(SANDBOX_DIR);
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function loadWatchState() {
  if (!existsSync(WATCH_STATE_FILE)) return { branches: {} };
  return JSON.parse(readFileSync(WATCH_STATE_FILE, "utf8"));
}

export function saveWatchState(state) {
  ensureDir(SANDBOX_DIR);
  writeFileSync(WATCH_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function getAllowedRepo(repoPath) {
  const config = loadConfig();
  const allowedRepos = Array.isArray(config?.allowedRepos) ? config.allowedRepos : [];
  const normalizedPath = realpathSync(repoPath);
  return allowedRepos.find((repo) => repo.path === normalizedPath) || null;
}

export function listAllowedRepos() {
  const config = loadConfig();
  return Array.isArray(config?.allowedRepos) ? config.allowedRepos : [];
}

export function stagingRemoteName(repoPath) {
  return basename(repoPath).replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function listStagingBranches(stagingPath) {
  const refsDir = join(stagingPath, "refs", "heads", "playsafe");
  if (!existsSync(refsDir)) return [];

  const branches = [];
  const walk = (dir, parts = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), [...parts, entry.name]);
      } else if (entry.isFile()) {
        const relative = [...parts, entry.name].join("/");
        branches.push(`playsafe/${relative}`);
      }
    }
  };

  walk(refsDir);
  return branches.sort();
}

export function isOsUserMode() {
  const config = loadConfig();
  return config?.mode === "os-user";
}
