# Cursor stack (`cursor-stack`)

Two twin scripts that install (or update) the **complete Cursor stack into a project** - skills,
MCP servers, hooks, convention rules, and subagents from the curated inventory in `cursor-stack.html`. The
result is a **self-contained `.cursor/` tree**: everything the agent needs lives under `.cursor/`,
with no external agent CLI in the loop. The agent is the script you run, so there is **no agent
argument**.

| Script                     | System        | Shell                                   |
| -------------------------- | ------------- | --------------------------------------- |
| `scripts/cursor-stack.sh`  | macOS / Linux | `bash`                                  |
| `scripts/cursor-stack.ps1` | Windows       | PowerShell 5.1 (Desktop) or 7+ (`pwsh`) |

The `.sh`/`.ps1` twins take the **same arguments** and produce the **same result**.

> Every artifact - skills, agents, rules, hooks - lives in this repo, and one source snapshot per run
> serves all of them (`STACK_SOURCE_REPO` overrides the source), so the stack is self-sourcing and a
> run cannot mix revisions. That snapshot is the rolling release archive (no git needed to take it),
> falling back to a shallow clone when no release is reachable. Each run stamps
> `.cursor/cursor-stack.stamp` with the source commit. The lint enforces that
> the `.sh`/`.ps1` twins agree and that every manifest entry has a real `skills/` dir. Cursor has
> **no `/plugin install`** system, so there is no plugins block - capabilities come from natives /
> Open-VSX extensions / MCPs instead (see below). To trim or extend, comment/uncomment manifest
> entries near the top of the script, then re-run; `npm run lint` (repo root) verifies the twins
> agree.

---

## What gets installed

| Component | Lands in | Notes |
| --------- | -------- | ----- |
| **Skills** (76) | `.cursor/skills/` | real copies; run as Cursor Skills (`agentskills.io`); includes `project-solve-cross-task` orchestration + routing (single-stack trios + cross-domain). Vendored in this repo's `skills/`, copied at install out of the release archive (clone fallback) (`scripts/cursor-stack.sh install skills-only`) |
| **MCP servers** (8) | `.cursor/mcp.json` | `angular-cli`, `serena` (`--context ide-assistant`), `playwright`, `memory`, `context7`, plus `chrome-devtools` + `appium-mcp` (heavy - active; comment out where not needed) and `sentry` (error monitoring - hosted remote MCP, `SENTRY_ACCESS_TOKEN` as an OS env var expanded via `${env:VAR}`; comment out without Sentry). `memory` is cross-project recall (the subagent handoff runs on serena) - comment it out in a standalone project. Cursor supports MCP natively; shell `${…}` path tokens are resolved to concrete paths and bare `${VAR}` secrets rewritten to `${env:VAR}` (Cursor does no shell interpolation) |
| **Hooks** (5) | `.cursor/hooks/` + `.cursor/hooks.json` | `guard-protected-force-push` + `guard-catastrophic-rm` + `guard-ungated-commit` (`beforeShellExecution`): block a force-push to a protected branch, an unrecoverable `rm -rf`, and a non-trivial commit with no review receipt. `guard-read-whole-file` (`beforeReadFile` + `beforeShellExecution`): a whole-file read of a large source file goes through serena first, by tool or by shell `cat`. `guard-unapproved-dispatch` (`subagentStart`): an implementer fan-out needs the recorded approval |
| **Rules** (19) | `.cursor/rules/` | six always-on `baseline-*.mdc` (`interaction` / `quality-gates` / `security` / `git` / `navigation` / `docs-root` - `alwaysApply`, the cross-cutting conventions) + the glob-auto-attaching convention rules `csharp` / `typescript` / `javascript` / `sql` / `angular`-conventions.mdc + `wpf-conventions.mdc` (`.xaml`, opt-in for WPF repos) + `winforms-conventions.mdc` (`.Designer.cs`) + `angular-styling-conventions.mdc` (`.scss`/`.css`, opt-in for Angular workspaces) + `devops-conventions.mdc` (Dockerfile/compose/workflows) + `markdown-docs.mdc` (`.md`, a trigger patch for the doc skills) + the two repair routers `dotnet-repair-agents.mdc` / `angular-repair-agents.mdc` (a red build/suite routes to a resolver seat) + `ponytail.mdc` (minimal-code, `alwaysApply`) |
| **Agents** (43) | `.cursor/agents/` | the 4 resolvers, the 10-stack designer/implementer/verifier trios (ASP.NET, web Angular, WPF, WinForms, console, Windows Service, Ionic Angular, data, DevOps, browser extension), the 4 cross-cutting seats (`runtime-failure-diagnoser`, `ci-failure-diagnoser`, `security-auditor`, `integration-reviewer`), and the 5 read-only support seats (`evidence-gatherer`, `architecture-analyzer`, `code-style-analyzer`, `test-coverage-analyzer`, `related-project-analyzer`). Cursor (2.5+) has a Task tool and subagents that inherit the parent's MCP servers, so the roster carries the full orchestration - `project-solve-cross-task` fans out designer/implementer/verifier via the Task tool, the diagnosers dispatch `evidence-gatherer`, and the serena-memory handoff works. Cursor specifics: `model: inherit` (no reliable effort/model pin), no per-tool `tools:` allowlist (only a `readonly` bool), `superpowers` optional via `/add-plugin`, and no hard-disable of auto-delegation. Fetched from the repo's `agents/` |

### Install cadence - keep always vs install on occasion

Cost differs by artifact, so the keep-or-skip call does too:

- **Skills** - permanent by default: keyword-gated and ~free when idle, so install all and let them self-gate. Whole-domain sets (the Ionic/Capacitor `mobile` group, `dotnet-wpf`) are optional only if you never touch that domain.
- **MCPs** - real launch cost, so split: baseline `context7` / `serena` / `memory` / `playwright`; domain-gated `angular-cli` (Angular projects only); opt-in `chrome-devtools` and `appium-mcp` (heavy native deps - left commented unless needed). `memory` is cross-project recall (the subagent handoff runs on serena) - comment it out in a standalone project.
- **Rules and agents** - permanent: the convention rules auto-attach by glob (free when no file matches) and `ponytail.mdc` is `alwaysApply`; the 43 agents run on demand - explicitly via `/name` or `@agent`, or the Task tool fans them out (`project-solve-cross-task` drives the designer/implementer/verifier flow, since Cursor 2.5+ supports subagent dispatch). Cursor has no plugins - per-language diagnostics come from Open-VSX extensions (install those matching the project's languages); design-taste guidance for distinctive UI lives in the `frontend` skill (installed like any Cursor skill).

---

## Plugins - there is no `/plugin install` in Cursor

Cursor adds capabilities three ways, none of them a plugin marketplace:

- **MCP servers** (native) - the five above, plus anything else in `.cursor/mcp.json`.
- **Native features** - Skills, Commands, Rules, Subagents (`.cursor/agents/` - the 33 agents
  this script installs, dispatched explicitly or fanned out via the Task tool), and **Bugbot**
  (`/review`) for security review.
- **Open-VSX VS Code extensions** - e.g. a Roslyn-based C# extension
  (DotRush / `muhammad-sammy.csharp` / ReSharper) since Microsoft's C# Dev Kit is blocked in Cursor.
  TypeScript diagnostics are built in. *(These are not installed by this script.)*

**Recommended manual add - `superpowers`.** It ships a Cursor plugin (a `.cursor-plugin` manifest
with 14 workflow skills + Cursor hooks). Get it with a one-time **`/add-plugin superpowers`** in
Cursor chat - `cursor-stack` can't script that UI step, so it's not auto-installed here.

`cursor-stack.html` has the full capability inventory. Note there is **no Cursor GUI equivalent of
a statusline HUD**; the closest is the Cursor **CLI** `/statusline` (terminal-only, scriptable) -
not installed here.

---

## Convention rules

The `.cursor/rules/*.mdc` carry the house conventions per file type. They are **soft guidance**
(auto-attached by glob when a matching file is in context), **not** a hard pre-edit block - Cursor
has no session "skill loaded" state and no stable pre-edit deny. The conventions themselves live in
the matching skill under `.cursor/skills/`.

| File types | House skill | Rule |
| ---------- | ----------- | ---- |
| `.cs` | `csharp` | `csharp-conventions.mdc` |
| `.ts` / `.tsx` / `.js` / `.jsx` / `.mjs` / `.cjs` | `typescript` | `typescript-conventions.mdc` |
| `.sql` | `database-conventions` | `sql-conventions.mdc` |
| `.component.ts` / `.service.ts` / … / `.component.html` | `angular-conventions` | `angular-conventions.mdc` |

An Angular `*.component.ts` matches both the TypeScript and Angular rules, so both attach together.

---

## Prerequisites

The script runs a **prerequisites check first and warns (never fails)** - install what you need, then re-run.

| Tool | Needed for | Required? | Install (macOS/Linux) | Install (Windows) |
| ---- | ---------- | --------- | --------------------- | ----------------- |
| **node** ≥ 22.12 LTS | the Cursor hook (runs via `node`), `npx` MCPs | **Yes** | `brew install node` / nvm | `winget install OpenJS.NodeJS.LTS` |
| **npx** | `npx` MCPs (e.g. context7 local transport; ships with node) | **Yes** | (with node) | (with node) |
| **git** | project-scope path resolution (repo root) | **Yes** for project scope | `brew install git` | `winget install Git.Git` |
| **uvx** (uv) | `serena` + `memory` MCPs | for those MCPs | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `irm https://astral.sh/uv/install.ps1 \| iex` |
| **python3** | the `.cursor/mcp.json` + `.cursor/hooks.json` merges (**bash only** - PowerShell merges natively) | **Yes** (bash) | `brew install python` | `winget install Python.Python.3.12` (Store stub does **not** count) |
| **curl** / `Invoke-WebRequest` | downloading the release archive every artifact is copied from | for the archive route (git covers the clone fallback) | preinstalled | preinstalled |
| **brew** / **winget** | `github-cli` extra only | optional | Homebrew | winget |

C# LSP (`csharp-ls`) is only relevant if you add the corresponding Open-VSX extension yourself -
this script does not install extensions.

---

## Before you run - environment variables & keys

### `SCOPE` - where the `.cursor/` tree lands (default `project`)

| Value | Cursor tree | Skills |
| ----- | ----------- | ------ |
| `project` (default) | `<repo>/.cursor/` | project-scoped |
| `global` | `~/.cursor/` | `-g` |

```bash
SCOPE=global bash $STACK/scripts/cursor-stack.sh install            # macOS/Linux
$env:SCOPE = 'global'; pwsh $Stack\scripts\cursor-stack.ps1 install # Windows
```

### `CONTEXT7_API_KEY` - the one secret (optional)

The `context7` MCP reads it from the environment at launch. Leave it unset in your install shell so
the registration stays keyless, and set it as a persistent OS/user env var (or in your shell
profile). Cursor resolves everything under `~/.cursor`.

---

## How to run

The **action** (`install` | `update`) is **required**; every other argument is optional with a default.

The script runs from wherever your clone of this repo lives - it finds the target project from the
working directory (`git rev-parse --show-toplevel`), not from its own location.

```bash
cd /path/to/your/project        # run inside the target project
STACK=~/path/to/cursor-stack    # your clone of this repo

bash $STACK/scripts/cursor-stack.sh install
bash $STACK/scripts/cursor-stack.sh update

# Optional extras (args 2+, any order): a space (separate memory DB), install gh, context7 transport
bash $STACK/scripts/cursor-stack.sh install work            # space 'work' -> memory_work.db
bash $STACK/scripts/cursor-stack.sh install github-cli
bash $STACK/scripts/cursor-stack.sh install context7-local  # local npx context7 (default: remote hosted server)
```

```powershell
Set-Location C:\path\to\your\project
$Stack = 'C:\path\to\cursor-stack'   # your clone of this repo

pwsh $Stack\scripts\cursor-stack.ps1 install
pwsh $Stack\scripts\cursor-stack.ps1 install work          # space 'work' -> memory_work.db (positional)
pwsh $Stack\scripts\cursor-stack.ps1 install -GitHubCli    # install gh (switch)
pwsh $Stack\scripts\cursor-stack.ps1 install -Context7 local  # local npx context7 (default: remote)
```

> On Windows PowerShell 5.1 use `powershell` instead of `pwsh`. If scripts are blocked, run once:
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

For Cursor, **`install` and `update` are effectively the same**: a clean skill re-add, then the
`.cursor/` tree (mcp.json, hooks, rules) is rewritten either way.

---

## Memory database

The `memory` MCP keeps its DB under **`~/.memory-mcp`**: default `memory.db`, or
`memory_<space>.db` with a **space** (e.g. `work`). The root is outside the project on purpose, so
recall carries across every project you install into. The path is resolved at install time and
baked into `.cursor/mcp.json`.

---

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| MCP dies at launch with `-32000` | Node too old (use ≥ 22.12 LTS); or a stale npm cache against a freshly pinned version. |
| `serena` / `memory` MCP missing | `uvx` not installed - install uv (see prereqs). `memory` also needs numpy, injected via `--with numpy`. |
| `.cursor/mcp.json` or `hooks.json` not written | Python 3 missing (bash path) - on Windows the Store stub doesn't count. |
| Hook / rule not installed | Copied from the run's source snapshot (the release archive, or a `-b main` clone if that is unreachable) - so the file must be committed + pushed to `main`. Check the `source:` line in the run's output and `.cursor/cursor-stack.stamp` for the commit actually installed. Fail-soft keeps any existing copy. |
| "not in a git repo - skipping…" | Project scope needs a git repo. Run `git init`, or use `SCOPE=global`. |
| C# diagnostics absent | Cursor ships no C# language server - install a Roslyn C# extension from Open VSX (see the plugins section). |
