# agent-sandbox

Run AI coding agents safely in a sandboxed macOS user. The agent gets a **read-only** GitHub PAT — it can clone and commit locally but **cannot push, create PRs, or merge**. When the agent pushes, a watcher intercepts it, pushes the branch for real, and creates a draft PR for your review.

Works with any coding agent: [Claude Code](https://claude.ai/code), [Codex](https://github.com/openai/codex), [Aider](https://aider.chat), [Goose](https://github.com/block/goose), or any CLI tool.

## Quickstart

```bash
# 1. Make sure gh CLI is authenticated (used to push and create draft PRs)
gh auth login

# 2. One command — sets up sandbox user, clones repo, drops you in
npx agent-sandbox https://github.com/owner/repo

# 3. You're now in the sandbox. Run your agent:
sandbox repo $ claude
sandbox repo $ codex --full-auto
sandbox repo $ aider

# 4. When the agent runs `git push`, it becomes a draft PR
#    The PR opens in your browser automatically

# 5. Ctrl+D to exit the sandbox
```

That's it. First time, it creates a macOS sandbox user, opens your browser to create a read-only PAT, clones the repo, starts the watcher, and drops you into a sandboxed shell. After that, just `cd repo && agent-sandbox`.

## How it works

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  sandbox-agent (macOS user) │     │  watcher (your user)         │
│                             │     │                              │
│  Any coding agent CLI       │     │  Started automatically       │
│  Git PAT: read-only         │────>│  gh CLI (authenticated)      │
│  git push intercepted       │ JSON│  Pushes branch for real      │
│  Branches: sandbox/*        │file │  Creates DRAFT PR            │
│                             │     │  Opens PR in browser         │
│  Can't access your creds    │     │  You review & merge          │
└─────────────────────────────┘     └──────────────────────────────┘
```

1. `agent-sandbox <url>` creates a sandboxed macOS user with a read-only GitHub PAT
2. A git wrapper intercepts all `git push` calls and routes them through a watcher
3. The watcher (running as your user) pushes the branch and creates a draft PR
4. All branches are auto-prefixed with `sandbox/` — no pushing to main/master
5. The draft PR opens in your browser. You review and merge when ready

## Usage

### First time (clone + enter sandbox)

```bash
agent-sandbox https://github.com/owner/repo
# or shorthand:
agent-sandbox owner/repo
```

### Already cloned (enter sandbox in current dir)

```bash
cd repo
agent-sandbox                              # sandboxed shell
agent-sandbox claude                       # run a specific command
agent-sandbox codex --full-auto            # pass args through
```

### What the agent sees

The agent works normally — `git checkout -b`, `git commit`, `git push` all work. But:

- Branches are auto-prefixed: `git checkout -b fix` → `sandbox/you/fix`
- `git push` creates a draft PR instead of pushing directly
- Force push is blocked
- Pushing to main/master/develop/release is blocked

## Commands

| Command | Description |
|---------|-------------|
| `agent-sandbox <repo-url>` | Clone, setup, and enter sandbox in one step |
| `agent-sandbox` | Enter sandbox in current dir |
| `agent-sandbox <cmd> [args]` | Run a command as the sandbox user |
| `agent-sandbox clone <url>` | Clone a repo without entering the sandbox |
| `agent-sandbox uninstall` | Remove the sandbox user and all config |

## Security model

- The agent runs as a **separate macOS user** (`sandbox-agent`) with no access to your credentials
- The agent's PAT is **read-only** — it cannot push, create PRs, or merge
- A git wrapper intercepts `git push` and routes it through a watcher
- The watcher pushes branches and creates **draft PRs** using your `gh` auth
- All branches are forced to `sandbox/*` — the agent can't push to protected branches
- Force pushing is blocked
- Draft PRs open in your browser for review
- Files created by the sandbox user are world-writable (you can `rm -rf` without sudo)

## Uninstall

```bash
agent-sandbox uninstall
```
