import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  AGENT_USER, AGENT_HOME, SANDBOX_DIR, SANDBOX_GIT_DIR, SANDBOX_WORKSPACE,
  CONFIG_FILE, exec, execLive, isRoot, userExists, ensureDir, isOsUserMode, loadConfig,
} from "./utils.mjs";

const USAGE = `
agent-sandbox run — Run a coding agent in the sandbox

Usage:
  agent-sandbox run <repo-url-or-path> --agent <command> [-- <agent-args>...]

Examples:
  agent-sandbox run https://github.com/owner/repo --agent claude -- --dangerously-skip-permissions
  agent-sandbox run https://github.com/owner/repo --agent codex -- --full-auto
  agent-sandbox run https://github.com/owner/repo --agent aider
  agent-sandbox run ./my-local-repo --agent claude

Options:
  --agent     The agent CLI command to run (e.g. claude, codex, aider, goose)
  -h, --help  Show this help
`.trim();

export async function run(argv) {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    console.log(USAGE);
    if (argv.length === 0) process.exit(1);
    return;
  }

  const config = loadConfig();
  if (!config) {
    console.error("Error: sandbox not configured. Run 'agent-sandbox setup' first.");
    process.exit(1);
  }

  const osUserMode = config.mode === "os-user";

  // Split on -- to separate our args from agent args
  const dashIdx = argv.indexOf("--");
  const ourArgs = dashIdx >= 0 ? argv.slice(0, dashIdx) : argv;
  const agentArgs = dashIdx >= 0 ? argv.slice(dashIdx + 1) : [];

  // Parse our args (before --)
  let repo;
  let agentCmd;
  for (let i = 0; i < ourArgs.length; i++) {
    if (ourArgs[i] === "--agent" && i + 1 < ourArgs.length) {
      agentCmd = ourArgs[i + 1];
      i++;
    } else if (!ourArgs[i].startsWith("-")) {
      repo = ourArgs[i];
    }
  }

  if (!agentCmd) {
    console.error("Error: --agent is required (e.g. --agent claude, --agent codex, --agent aider)\n");
    console.log(USAGE);
    process.exit(1);
  }

  if (!repo) {
    console.error("Error: repo URL or path is required\n");
    console.log(USAGE);
    process.exit(1);
  }

  if (osUserMode) {
    await runOsUser(repo, agentCmd, agentArgs);
  } else {
    await runDirectory(repo, agentCmd, agentArgs);
  }
}

async function runOsUser(repo, agentCmd, agentArgs) {
  if (!isRoot()) {
    console.error("Error: OS-user mode requires sudo. Use: sudo agent-sandbox run ...");
    process.exit(1);
  }

  if (!userExists(AGENT_USER)) {
    console.error(`Error: user '${AGENT_USER}' does not exist. Run 'sudo agent-sandbox setup --os-user' first.`);
    process.exit(1);
  }

  const workspace = `${AGENT_HOME}/workspace`;
  let repoDir;

  if (repo.startsWith("http") || repo.startsWith("git@")) {
    const repoName = basename(repo, ".git");
    repoDir = `${workspace}/${repoName}`;

    exec(`sudo -u ${AGENT_USER} mkdir -p "${workspace}"`);

    if (existsSync(repoDir)) {
      console.log(`Updating existing clone at ${repoDir}...`);
      exec(`sudo -u ${AGENT_USER} git -C "${repoDir}" fetch --all`);
      try { exec(`sudo -u ${AGENT_USER} git -C "${repoDir}" pull --ff-only`); } catch {}
    } else {
      console.log(`Cloning ${repo}...`);
      exec(`sudo -u ${AGENT_USER} git clone "${repo}" "${repoDir}"`);
    }
  } else {
    repoDir = repo;
  }

  console.log(`Starting '${agentCmd}' as '${AGENT_USER}' in ${repoDir}...`);
  console.log("---");

  await execLive("sudo", ["-u", AGENT_USER, agentCmd, ...agentArgs], { cwd: repoDir });
}

async function runDirectory(repo, agentCmd, agentArgs) {
  const gitConfig = `${SANDBOX_GIT_DIR}/config`;
  if (!existsSync(gitConfig)) {
    console.error("Error: sandbox not configured. Run 'agent-sandbox setup' first.");
    process.exit(1);
  }

  let repoDir;

  if (repo.startsWith("http") || repo.startsWith("git@")) {
    const repoName = basename(repo, ".git");
    repoDir = `${SANDBOX_WORKSPACE}/${repoName}`;

    ensureDir(SANDBOX_WORKSPACE);

    const gitEnv = { GIT_CONFIG_GLOBAL: gitConfig };

    if (existsSync(repoDir)) {
      console.log(`Updating existing clone at ${repoDir}...`);
      exec(`git -C "${repoDir}" fetch --all`, { env: { ...process.env, ...gitEnv } });
      try { exec(`git -C "${repoDir}" pull --ff-only`, { env: { ...process.env, ...gitEnv } }); } catch {}
    } else {
      console.log(`Cloning ${repo}...`);
      exec(`git clone "${repo}" "${repoDir}"`, { env: { ...process.env, ...gitEnv } });
    }
  } else {
    repoDir = resolve(repo);
  }

  console.log(`Starting '${agentCmd}' in ${repoDir}...`);
  console.log("---");

  // Run agent with the sandboxed git config
  await execLive(agentCmd, agentArgs, {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: gitConfig,
    },
  });
}
