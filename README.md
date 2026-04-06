# playsafe

Let AI coding agents play — safely. Agents run in a sandboxed macOS user with a **read-only** GitHub PAT. They can clone, edit, and commit — but **cannot push, create PRs, or merge**. When an agent runs `git push`, it's intercepted and becomes a draft PR for your review.

Works with any coding agent: [Claude Code](https://claude.ai/code), [Codex](https://github.com/openai/codex), [Aider](https://aider.chat), [Goose](https://github.com/block/goose), or any CLI tool.

## Quickstart

```bash
# 1. Make sure gh CLI is authenticated (used to push and create draft PRs)
gh auth login

# 2. One command — sets up everything and drops you into the sandbox
npx playsafe https://github.com/owner/repo

# 3. You're in the sandbox. Run your agent:
playsafe repo $ claude
playsafe repo $ codex --full-auto
playsafe repo $ aider

# 4. When the agent runs `git push`, it becomes a draft PR
#    The PR opens in your browser automatically

# 5. Ctrl+D to exit the sandbox
```

First time, playsafe creates a macOS sandbox user, opens your browser to create a read-only PAT, clones the repo, and drops you in. After that, just `cd repo && playsafe`.

## How it works

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  playsafe-user (macOS user) │     │  watcher (your user)         │
│                             │     │                              │
│  Any coding agent CLI       │     │  Started automatically       │
│  Git PAT: read-only         │────>│  gh CLI (authenticated)      │
│  git push intercepted       │ JSON│  Pushes branch for real      │
│  Branches: playsafe/*        │file │  Creates DRAFT PR            │
│                             │     │  Opens PR in browser         │
│  Can't access your creds    │     │  You review & merge          │
└─────────────────────────────┘     └──────────────────────────────┘
```

1. `playsafe <url>` creates a sandboxed macOS user with a read-only GitHub PAT
2. A git wrapper intercepts `git push` and routes it through a watcher process
3. The watcher (running as your user) pushes the branch and creates a draft PR
4. All branches are auto-prefixed with `playsafe/` — no pushing to main/master
5. The draft PR opens in your browser. You review and merge when ready

## Usage

### First time

```bash
playsafe https://github.com/owner/repo
# or shorthand:
playsafe owner/repo
```

### Already cloned

```bash
cd repo
playsafe                              # enter playsafe shell
playsafe claude                       # run a specific command
playsafe codex --full-auto            # pass args through
```

### What the agent sees

The agent works normally — `git checkout -b`, `git commit`, `git push` all work. But:

- Branches are auto-prefixed: `git checkout -b fix` → `playsafe/you/fix`
- `git push` creates a draft PR instead of pushing directly
- Force push is blocked
- Pushing to main/master/develop/release is blocked

## Commands

| Command | Description |
|---------|-------------|
| `playsafe <repo-url>` | Clone, setup, and enter sandbox in one step |
| `playsafe` | Enter sandbox in current dir |
| `playsafe <cmd> [args]` | Run a command as the sandbox user |
| `playsafe uninstall` | Remove the sandbox user and all config |

## Security model

- The agent runs as a **separate macOS user** (`playsafe-user`) with no access to your credentials
- The agent's PAT is **read-only** — it cannot push, create PRs, or merge
- A git wrapper intercepts `git push` and routes it through a watcher
- The watcher pushes branches and creates **draft PRs** using your `gh` auth
- All branches are forced to `playsafe/*` — the agent can't push to protected branches
- Force pushing is blocked
- Draft PRs open in your browser for review
- Files created by the sandbox user are world-writable (you can `rm -rf` without sudo)

## Uninstall

```bash
playsafe uninstall
```
