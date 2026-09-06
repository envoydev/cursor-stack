# CLAUDE.md - cursor-stack repo

## What this repo is

The single source of truth for the **Cursor** half of a coding-agent setup - not an
application. It was split out of the Claude stack (`claude-stack`, still the peer repo, renamed
from `agents-stack`), and is now **fully standalone**: this repo owns the whole Cursor delivery -
the installers, the 76 vendored skills, the 43 Cursor-contract subagents, the `.mdc` rules, the
hooks, and the `templates/AGENTS.template.md` base template. The installer downloads THIS repo's
release archive (clone fallback) to copy `skills/` in, so nothing is fetched from the peer at install. Consuming projects pull from here -
they do not own their copy; a change made only inside a consuming project is throwaway (see
Invariants).

## Layout - one home per concern

- `scripts/cursor-stack.{sh,ps1}` - the installer twins (same args, same result); they locate the
  target project via `git rev-parse --show-toplevel`, so they run from anywhere.
  `cursor-stack.html` - the browser inventory.
- `templates/AGENTS.template.md` - the stack-neutral per-project skeleton each consuming project's
  `AGENTS.md` is filled in from (Cursor reads `AGENTS.md`).
- `skills/` - the 76 vendored Cursor Skills (`agentskills.io`: one dir per skill, each with a
  `SKILL.md`), copied into a project's `.cursor/skills/` out of the run's source snapshot. The
  18 orchestration skills carry `disable-model-invocation: true` (Cursor honours it for
  repo-level skills: the skill loads only on an explicit `/name`).
- `agents/` - the 43 Cursor-contract subagents, copied into a project's `.cursor/agents/`.
  Cursor (2.5+) has a Task tool and MCP-inheriting subagents, so they keep the full orchestration
  (`project-solve-cross-task` fans out designer -> implementer -> verifier, the diagnosers dispatch
  `evidence-gatherer`, the serena-memory handoff works). Cursor's platform limits shape the
  contract: `model: inherit` (no reliable model/effort pin), no per-tool `tools:` allowlist (only
  a `readonly` bool), no frontmatter `skills:` preload (each seat is told to READ the SKILL.md
  files it needs), `superpowers` optional via `/add-plugin`, and no hard-disable of
  auto-delegation.
- `rules/` - 19 `.mdc` rules copied into a project's `.cursor/rules/`: six always-on
  `baseline-*.mdc` (`alwaysApply` - interaction / quality-gates / security / git / navigation /
  docs-root, whose `__DOCS_ROOT__` line the installer stamps) + nine glob-auto-attaching convention
  rules (csharp / typescript / javascript / sql / angular / angular-styling / wpf / winforms /
  devops) + `markdown-docs.mdc` (a trigger patch: the doc skills' keywords miss a plain `.md`
  content edit) + the two repair routers (`dotnet-` / `angular-repair-agents.mdc`: a red build or
  suite goes to a resolver seat) + the always-on `ponytail.mdc`.
- `hooks/` - five guards in Cursor's hook contract, wired via `.cursor/hooks.json`: three on
  `beforeShellExecution` (`guard-protected-force-push.js`, `guard-catastrophic-rm.js`,
  `guard-ungated-commit.js`), `guard-read-whole-file.js` on both `beforeReadFile` and
  `beforeShellExecution`, and `guard-unapproved-dispatch.js` on `subagentStart`. Each answers
  an allow/deny permission on stdout, and appends one JSONL row per BLOCK under `<docs-path>/hook-blocks/` - a block costs its denial plus the retried turn, so the block RATE is the number that says a gate earns its keep. `guard-ungated-commit` gates PUBLISHING too (`<docs-path>/flow/PUSH-GATE`, same five-line receipt; `CURSOR_PUSH_GATE=0` turns that half off where the remote is already gated); its two receipt checks that read the session TRANSCRIPT fail open here by construction - Cursor sends none - which the hook header states rather than leaving to a reader to assume. Two peer guards have no Cursor home and are deliberately
  absent: a stop-contract gate (the `stop` hook cannot block and never receives the response
  text, and there is no question tool to gate) and usage instrumentation (its analyzer reads a
  transcript format Cursor does not produce).
- `scripts/guard-hooks.test.js` - behavior tests for the five guards (`npm test` runs the lint then
  these), driving each hook the way Cursor does: payload JSON on stdin, permission read off stdout.
  They exist because the guards are PORTED, and a port is exactly where a gate quietly stops gating -
  one of them pins a bug the port itself surfaced, where an absolute in-repo docs root made every
  conformant receipt fail its own file count.
- `scripts/lint-stack.js` - the repo lint (`npm run lint`, beside the installer twins), dependency-free
  by design: `.sh`/`.ps1` twin parity (SKILLS set + order, MCPS, no PLUGINS), on-disk agents/rules/hooks
  == the manifest arrays, `skills/` dirs == the manifest entries (each with a `SKILL.md` whose
  frontmatter loads and carries only Cursor's five fields), HTML sync, README headline counts, the
  backticked-token check over skills/agents/rules/template, and the no-Claude-framing guard.

## The ownership model - everything is owned here

- **Owned here:** everything - skills, agents, rules, hooks, template, installers, HTML. Every
  artifact is copied out of ONE source snapshot per run (`STACK_SOURCE_REPO` overrides the source;
  `STACK_SKILLS_REPO` is the legacy alias), so a change ships only once committed + pushed to
  `main`; until then the per-file fail-soft keeps any existing copy. One snapshot, not ~47 per-file
  `raw.githubusercontent.com` fetches: raw is CDN-cached (~5 min after a push) and a snapshot is
  not, so the old split could straddle a push and install skills from one revision and
  agents/rules/hooks from another.
- **The snapshot is the rolling release archive, then a clone.** `release.yml` republishes the
  rolling `latest` release on every push to `main` (a tar.gz + a zip of that revision, each
  carrying a `RELEASE-SOURCE` file naming the commit). A run downloads it - one asset is one
  revision, and taking it needs no git - and falls back to a shallow clone only when no release is
  reachable: a fork without releases, a blocked CDN, a local path (which is how the tests and CI
  drive it), or the brief window the release job's delete/recreate opens. That fallback clone is
  pinned `-b main` - installs deliver the release branch regardless of what the repo's default
  branch happens to be, so `develop` work stays invisible until it is released. The `.sh` takes the
  tar.gz, the `.ps1` takes the zip (`Expand-Archive` is native) - that is why both are published.
  Each run stamps `.cursor/cursor-stack.stamp` with the source commit (from `RELEASE-SOURCE` on the
  archive route, from `HEAD` on the clone route) - Cursor has no per-artifact `version:` field, so
  the INSTALL is what gets versioned. A run that resolves no revision writes no stamp: a wrong
  stamp is worse than none.
- **The peer repo (`claude-stack`) is a SIBLING, not an upstream.** The two stacks were forked
  from one source and still share skill *content* and the `MCPS` baseline by descent, so a
  baseline improvement is usually worth porting BOTH ways - but nothing here reads from there at
  runtime, and neither repo's lint can see the other. Divergence is expected and allowed; it is
  no longer a defect to reconcile.
- **The public surface carries no Claude framing** - and the lint proves it, so this is a gate,
  not a good intention. README, `cursor-stack.html`, the installers, the skills, the agents and
  the rules describe Cursor on its own terms - never 'the twin of X', never 'Claude-only'.
  `CLAUDE.md` (this file) and `.claude/` are the only exceptions, plus the
  `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_CONFIG_DIR}` MCPS path tokens, which are functional: they
  are resolved to concrete paths before `.cursor/mcp.json` is written and never reach a user.
- **Things that must NOT grow back here:** plugins (Cursor has no `/plugin install`; equivalents
  are natives / Open-VSX / MCPs - the lint fails any active PLUGINS entry), `model:` / `effort:`
  frontmatter pins (Cursor's SKILL.md and agent schemas have no such fields - they are silently
  dead), per-tool `tools:` allowlists (Cursor has only a `readonly` bool), and a frontmatter
  `skills:` preload list (no such field either - a seat that needs a skill READS its SKILL.md,
  which is why the agent bodies name the files explicitly rather than assuming they arrived).

## Working in THIS repo - invariants

- **Branching: `develop` carries the work, `main` releases.** Land everything on `develop` (branch
  off it for anything non-trivial); merging `develop` -> `main` IS the release act - `release.yml`
  rebuilds the rolling `latest` archive from that merge, and that revision is what every install
  delivers. Never commit feature work straight to `main`. The installers no longer depend on which
  branch is default - the release archive is built from `main` and the clone fallback is pinned
  `-b main` - but keep `main` the default anyway: it is what a visitor and a plain `git clone` land
  on. CI
  gates every push to `develop` and `main` plus every PR into either - but note it cannot *block* a
  release: `release.yml` fires on the `main` push independently, so a red `main` publishes anyway.
  Branch protection on `main` (require the PR + green checks) is what would actually gate that.
- **Public repo.** No private project names or absolute local paths in any tracked file -
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
- Hooks, rules, and agents are copied from the run's source clone of `main` - a change ships only
  once committed + pushed. Check `.cursor/cursor-stack.stamp` in a consuming project to see which
  commit its tree actually came from.
- The skills and agents share ancestry with the peer repo's, so a protocol fix there is often
  worth porting here (and vice versa) - but nothing enforces it and divergence is not a defect.
  Port on merit, not on principle; never copy the peer's framing along with the fix.
- Cursor's SKILL.md schema is `name` / `description` / `paths` / `disable-model-invocation` /
  `metadata` - nothing else. A `model:` or `effort:` pin carried over from the peer is dead
  weight, not a behavior; strip it rather than leave prose claiming a pin that never fires.
