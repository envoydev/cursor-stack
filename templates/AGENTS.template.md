# AGENTS.md (stack-neutral template)

<!-- Fill-in block - delete once done. Copy this file into a new project as AGENTS.md at the repo
     root, where Cursor reads it automatically. It is a normal committed file - nothing to unignore.
     Then:
1. Write the project top from the authoring outline in the comment below - replace the H1 title
   with the project's own name, put the intro above ## Rules - then delete that comment.
2. Trim the ## Rules table to what the installer actually laid down - and drop any GENERATED
   row whose capture skill this install skipped (its /command will not resolve).
3. Run the captures that write the rows marked GENERATED: /project-agent-capabilities,
   /project-architecture-analyzer, /project-code-style-analyzer - plus /project-related-context
   ONLY when this project has sibling repos (a standalone repo drops that row instead). They are
   slash-only (`disable-model-invocation`): the user types them, and a model invocation is refused.
This file is injected every session and into subagents - keep it lean and route work by an
observable trigger (an artifact, a command, a checkpoint). The cross-project working conventions
are NOT here: they load from the always-on baseline rules in .cursor/rules/ (installer-managed,
refreshed on update) - never restate them in this file, and never paste a rule's contents in
either: the rules load on their own, so a copy is paid for twice. (HTML comment: stripped from
injection, so an unfilled template pays nothing for this block.) -->

## Rules

The always-on baseline set in `.cursor/rules/` - one concern per file, all loaded every session;
this table maps where each behavior rule lives (the detail is in the rules, not here). Glob-scoped
rules in the same directory attach on a matching file touch - their own `globs:` frontmatter says
when. In GENERATED rows, `user-run` marks a slash-only capture (`disable-model-invocation`): only
the user can invoke it, so name the command to the user rather than running it.

| Rule | What it governs |
|---|---|
| `.cursor/rules/baseline-interaction.mdc` | communication style, adversarial review of user proposals, formatting + privacy, planning/execution thresholds |
| `.cursor/rules/baseline-quality-gates.mdc` | code-quality bars and the done-claim verification gate |
| `.cursor/rules/baseline-security.mdc` | `/review` routing, PII/secret handling, the `.cursorignore` caveat |
| `.cursor/rules/baseline-git.mdc` | commits, branches, PRs, push discipline, the pre-commit checkpoint |
| `.cursor/rules/baseline-navigation.mdc` | symbol-lookup and code-reading discipline |
| `.cursor/rules/baseline-docs-root.mdc` | the generated-docs root - the installer-stamped path `<docs-path>` resolves to, what lives under it, the capture-doc lifecycle |
| `.cursor/rules/ponytail.mdc` | minimal-code discipline - the simplest solution that actually works |
| `.cursor/rules/baseline-project-agent-capabilities.mdc` (GENERATED - user-run /project-agent-capabilities after install, update, or a trim) | the usage policy plus this project's real skill / seat / MCP inventory |
| `.cursor/rules/baseline-project-architecture.mdc` (GENERATED - user-run /project-architecture-analyzer) | architecture awareness - the micro-summary plus the read-the-map trigger into `<docs-path>/architecture/` |
| `.cursor/rules/baseline-project-related-context.mdc` (GENERATED, OPTIONAL - only where the project has sibling repos; user-run /project-related-context with their paths/URLs, else delete this row) | sibling-repo awareness - name / location / relation / seam per sibling |
| `.cursor/rules/project-code-style.mdc` (GENERATED - user-run /project-code-style-analyzer; glob-scoped, plus the full doc) | the project's actual code style - the condensed core auto-attaches on any matching file touch (main session and subagents); the full capture stays in `<docs-path>/PROJECT-CODE-STYLE.md` |

<!-- Authoring outline - write these sections into the project-specific top of this file
(each section lean; interleave as reads best - the project intro usually comes first, above
## Rules), then delete this comment block. Comments are stripped from injection, so this
outline costs nothing even while it sits here.

Project - what it is:

1. What this project is - one paragraph: domain, shape (binary / service / library), persistence, surfaces.
2. Architecture - layers / modules, dependency rules, folder organization.
3. Key patterns - the non-obvious in-house patterns a newcomer would trip on.
4. Operational notes - runtime constraints and gotchas that shape code decisions.
5. Cross-cutting checklists - for each change that must move several files in lockstep, the full touch-point list.

Stack - what it is built with:

6. Stack - languages, frameworks, key libraries, test stack + coverage gate, and the Open-VSX
   language-server extension for the primary language(s). Cursor has no /plugin install: language
   diagnostics come from extensions (on C# use a Roslyn-based one - Microsoft's C# Dev Kit is
   blocked here), and other capability from MCP servers or Cursor natives. MCP routing is NOT
   hand-filled here - it lives in the generated
   .cursor/rules/baseline-project-agent-capabilities.mdc (user-run /project-agent-capabilities; if
   that skill was not installed, a lean hand-filled routing list here is the fallback).
7. Commands - copy-pasteable build / test / run / migrate / publish, with any environment quirks.
8. Secrets + config - where this project's secrets / env config live (the globs); mirror them into
   .cursorignore so they never reach the model - the stack expects only the generic .env* / key /
   cert shapes, never this project's own paths.
9. Code conventions - the house-style skill for each file type (auto-attached by the glob-scoped rules above).
10. Testing approach - per-layer strategy, what's excluded, the integration / regression net.
11. Load by artifact - a table mapping this repo's concrete files / types / constructs to the third-party skills it can't re-describe (house-style skills self-fire, so they're not in it).
-->
