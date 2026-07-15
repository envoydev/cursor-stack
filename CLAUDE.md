# CLAUDE.md - personal cursor-stack repo

## What this repo is

The single source of truth for the **Cursor** half of a personal coding-agent setup - not an
application. It was split out of the Claude stack (`claude-stack`, still the peer repo, renamed
from `agents-stack`), and is now **fully standalone**: this repo owns the whole Cursor delivery -
the installers, the 65 vendored skills, the 33 Cursor-contract subagents, the `.mdc` rules, the
hooks, and the `AGENTS.template.md` base template. The installer clones THIS repo to copy
`skills/` in, so nothing is fetched from the peer at install. Consuming projects pull from here -
they do not own their copy; a change made only inside a consuming project is throwaway (see
Invariants).

## Layout - one home per concern

- `scripts/cursor-stack.{sh,ps1}` - the installer twins (same args, same result); they locate the
  target project via `git rev-parse --show-toplevel`, so they run from anywhere.
  `cursor-stack.html` - the browser inventory.
- `AGENTS.template.md` - the stack-neutral per-project skeleton each consuming project's
  `AGENTS.md` is filled in from (Cursor reads `AGENTS.md`).
- `skills/` - the 65 vendored Cursor Skills (`agentskills.io`: one dir per skill, each with a
  `SKILL.md`), copied into a project's `.cursor/skills/` by the installer's git-clone step. The
  14 orchestration skills carry `disable-model-invocation: true` (Cursor honours it for
  repo-level skills: the skill loads only on an explicit `/name`).
- `agents/` - the 33 Cursor-contract subagents, fetched into a project's `.cursor/agents/`.
  Cursor (2.5+) has a Task tool and MCP-inheriting subagents, so they keep the full orchestration
  (`project-task-flow` fans out designer -> implementer -> verifier, the diagnosers dispatch
  `evidence-gatherer`, the serena-memory handoff works). Cursor's platform limits shape the
  contract: `model: inherit` (no reliable model/effort pin), no per-tool `tools:` allowlist (only
  a `readonly` bool), `superpowers` optional via `/add-plugin`, and no hard-disable of
  auto-delegation.
- `rules/` - twelve `.mdc` rules fetched into a project's `.cursor/rules/`: five always-on
  `baseline-*.mdc` (`alwaysApply` - interaction / quality-gates / security / git / navigation) +
  six glob-auto-attaching convention rules + the always-on `ponytail.mdc`.
- `hooks/` - `guard-protected-force-push.js` + `guard-catastrophic-rm.js` in Cursor's
  `beforeShellExecution` contract, wired via `.cursor/hooks.json`.
- `scripts/lint-stack.js` - the repo lint (`npm run lint`, beside the installer twins): `.sh`/`.ps1` twin parity (SKILLS set
  + order, MCPS, no PLUGINS), on-disk agents/rules/hooks == the manifest arrays, `skills/` dirs ==
  the manifest entries (each with a `SKILL.md`), HTML sync, README headline counts, and the
  backticked-token check over agents/rules/template.

## The ownership model - everything is owned here

- **Owned here:** everything - skills, agents, rules, hooks, template, installers, HTML. The
  skills are vendored under `skills/` and copied in by cloning THIS repo
  (`STACK_SKILLS_REPO` overrides the source); agents/rules/hooks are fetched from THIS repo's
  `main` (`raw.githubusercontent.com/envoydev/cursor-stack/main/...`), so a change ships only
  once committed + pushed; until then the per-file fail-soft keeps any existing copy.
- **The peer repo (`claude-stack`) is a SIBLING, not an upstream.** The two stacks were forked
  from one source and still share skill *content* and the `MCPS` baseline by descent, so a
  baseline improvement is usually worth porting BOTH ways - but nothing here reads from there at
  runtime, and neither repo's lint can see the other. Divergence is expected and allowed; it is
  no longer a defect to reconcile.
- **The public surface carries no Claude framing.** README, `cursor-stack.html`, the installers,
  the skills, the agents and the rules describe Cursor on its own terms - never 'the twin of X',
  never 'Claude-only'. `CLAUDE.md` (this file) and `.claude/` are the only exceptions, plus the
  `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_CONFIG_DIR}` MCPS path tokens, which are functional: they
  are resolved to concrete paths before `.cursor/mcp.json` is written and never reach a user.
- **Things that must NOT grow back here:** plugins (Cursor has no `/plugin install`; equivalents
  are natives / Open-VSX / MCPs - the lint fails any active PLUGINS entry), `model:` / `effort:`
  frontmatter pins (Cursor's SKILL.md and agent schemas have no such fields - they are silently
  dead), and per-tool `tools:` allowlists (Cursor has only a `readonly` bool).

## Working in THIS repo - invariants

- **Public repo.** No private project names or absolute personal paths in any tracked file -
  generic 'consuming project' references only.
- **Parity / source-of-truth.** Each `.sh`/`.ps1` twin matches its sibling; `npm run lint`
  enforces it (plus disk == manifest and the HTML). Never patch only a generated `.cursor/` tree
  or a consuming project's copy - the installer regenerates and silently wipes it. A skill change
  lands in `skills/` here and its manifest entry in the same sitting; porting it to the peer is a
  separate, optional call.
- **One home per piece, no duplication.** A deterministic gate at a discrete event -> a hook. A
  per-file-type convention -> a glob-attaching `.mdc` rule pointing at its house skill.
  Cross-cutting guidance -> the always-on `baseline-*.mdc` set. The base template carries only
  per-project structure + platform routing, never the baseline conventions. Never state one
  trigger twice.
- **Prove a behavioral change, don't assert it.** A routing or contract change ships only with
  evidence - run the affected flow and read the code, never a run's self-report.
- **House voice:** direct, lean, single dashes not em-dashes, single quotes in prose, recommend
  one option with a reason.

## Maintenance gotchas

- The installer regenerates `.cursor/mcp.json` / `hooks.json` / rules on every run - fix the
  source here, not the output in a consuming project.
- Hooks, rules, and agents are fetched from GitHub at install - a change ships only once
  committed + pushed to `main`.
- The skills and agents share ancestry with the peer repo's, so a protocol fix there is often
  worth porting here (and vice versa) - but nothing enforces it and divergence is not a defect.
  Port on merit, not on principle; never copy the peer's framing along with the fix.
- Cursor's SKILL.md schema is `name` / `description` / `paths` / `disable-model-invocation` /
  `metadata` - nothing else. A `model:` or `effort:` pin carried over from the peer is dead
  weight, not a behavior; strip it rather than leave prose claiming a pin that never fires.
