# CLAUDE.md - personal cursor-stack repo

## What this repo is

The single source of truth for the **Cursor** half of a personal coding-agent setup - not an
application. It was split out of `agents-stack` (the Claude Code stack, still the peer repo):
this repo owns the Cursor DELIVERY - the installers, the 33 Cursor-contract subagents, the
`.mdc` rules, the hooks, and the `AGENTS.template.md` base template - while the **skills and
the MCP baseline stay shared with the Claude stack and live in `agents-stack`**: the installers
here git-clone `envoydev/agents-stack` and copy `skills/` at install. Consuming projects pull
from here - they do not own their copy; a change made only inside a consuming project is
throwaway (see Invariants).

## Layout - one home per concern

- `cursor-stack.{sh,ps1}` - the installer twins (same args, same result). `cursor-stack.html` -
  the browser inventory.
- `AGENTS.template.md` - the stack-neutral per-project skeleton each consuming project's
  `AGENTS.md` is filled in from (Cursor reads `AGENTS.md`).
- `agents/` - the 33 Cursor-contract twins of the Claude subagents, fetched into a project's
  `.cursor/agents/`. Cursor (2.5+) has a Task tool and MCP-inheriting subagents, so they keep the
  full orchestration (`project-task-flow` fans out designer -> implementer -> verifier, the
  diagnosers dispatch `evidence-gatherer`, the serena-memory handoff works). They differ from the
  Claude roster only in the genuine platform gaps: `model: inherit` (no reliable model/effort
  pin), no per-tool `tools:` allowlist (only a `readonly` bool), `superpowers` optional via
  `/add-plugin`, and no hard-disable of auto-delegation.
- `rules/` - twelve `.mdc` rules fetched into a project's `.cursor/rules/`: five always-on
  `baseline-*.mdc` (`alwaysApply` - interaction / quality-gates / security / git / navigation,
  twins of the Claude `baseline-*.md` set) + six glob-auto-attaching convention rules + the
  always-on `ponytail.mdc`.
- `hooks/` - `guard-protected-force-push.js` + `guard-catastrophic-rm.js` in Cursor's
  `beforeShellExecution` contract, wired via `.cursor/hooks.json`.
- `scripts/lint-stack.js` - the repo lint (`npm run lint`): `.sh`/`.ps1` twin parity (SKILLS set
  + order, MCPS, no PLUGINS), on-disk agents/rules/hooks == the manifest arrays, HTML sync,
  README headline counts, and the backticked-token check over agents/rules/template.

## The split model - what is shared, what is owned

- **Shared with `agents-stack` (a baseline change is a TWO-REPO commit):** the `SKILLS` and
  `MCPS` manifest lists. The skills themselves are cloned from `envoydev/agents-stack` at
  install (`STACK_SKILLS_REPO` overrides the source); only the manifest lists are duplicated
  here, and each repo's lint proves its own `.sh`/`.ps1` twins agree - cross-repo parity is held
  by discipline, not by a networked lint.
- **Owned here:** everything Cursor-specific - agents, rules, hooks, template, installers, HTML.
  These are fetched from THIS repo's `main` at install
  (`raw.githubusercontent.com/envoydev/cursor-stack/main/...`), so a change ships only once
  committed + pushed; until then the per-file fail-soft keeps any existing copy.
- **Claude-only things that must NOT grow back here:** plugins (Cursor has no
  `/plugin install`; equivalents are natives / Open-VSX / MCPs - the lint fails any active
  PLUGINS entry), the model/effort frontmatter pins, per-tool `tools:` allowlists, and the
  Claude `.claude/rules` set.

## Working in THIS repo - invariants

- **Public repo.** No private project names or absolute personal paths in any tracked file -
  generic 'consuming project' references only.
- **Parity / source-of-truth.** Each `.sh`/`.ps1` twin matches its sibling; `npm run lint`
  enforces it (plus disk == manifest and the HTML). Never patch only a generated `.cursor/` tree
  or a consuming project's copy - the installer regenerates and silently wipes it. A skills/MCP
  baseline change lands in `agents-stack` FIRST (the skills live there), then the manifest lists
  here in the same sitting.
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
- The agents are TWINS of the Claude roster in `agents-stack` - a protocol change to a Claude
  agent usually needs the same edit to its twin here (and vice versa); check the peer repo
  before treating a divergence as deliberate. The deliberate divergences are the platform gaps
  listed under Layout, nothing else.
