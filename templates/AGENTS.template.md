# AGENTS.md (stack-neutral template)

<!-- Fill-in block - delete once done. Copy this file into a new project as AGENTS.md at the repo
     root, where Cursor reads it automatically. It is a normal committed file - nothing to unignore.
     Then:
1. Write the project top from the authoring outline in the comment below - replace the H1 title
   with the project's own name, put the sections above ## Rules so the rules table stays last - then
   delete that comment.
2. Trim the ## Rules table to what the installer actually laid down - and drop any GENERATED
   row whose capture skill this install skipped (its /command will not resolve).
3. Run the captures that write the rows marked GENERATED: /project-agent-capabilities,
   /project-architecture-analyzer, /project-code-style-analyzer - plus /project-related-context
   ONLY when this project has sibling repos (a standalone repo drops that row instead). They are
   slash-only (`disable-model-invocation`): the user types them, and a model invocation is refused.
In a monorepo this is the ROOT file - shared conventions only; a package that needs its own gets a
thin AGENTS.md in its directory carrying just what is specific to that subtree (Cursor applies a
nested AGENTS.md when working with files in that directory, combined with the parent's, the more
specific one winning), so anything two packages share belongs here.
This file is injected every session and into subagents - keep it lean (target: under 200 live
lines) and route work by an observable trigger (an artifact, a command, a checkpoint). The test for
every line you add: would removing it make the agent make a mistake? If not, cut it - what the agent
can read from the code, standard language conventions, file-by-file tours, rules the formatter
already owns (.editorconfig, ESLint, Prettier, dotnet format) and 'write clean code' never earn their
tokens; commands it cannot guess, conventions that differ from defaults, gotchas and repository
etiquette do. Five shapes to keep out, whatever they cost: the aspiration document (vague wishes),
the wishlist (conventions the author wants instead of the ones the code enforces - an inherited
codebase's own conventions win), the freeze (never touched while the repo moved on), the TODO ledger
(scratch notes), and the single source (everything here, nothing routed to a scoped rule or a
skill). Prune it when things go wrong, and test a change by watching whether behaviour shifts.
The cross-project working conventions are NOT here: they load from the always-on baseline rules in
.cursor/rules/ (installer-managed, refreshed on update) - never restate them in this file, and never
paste a rule's contents in either: the rules load on their own, so a copy is paid for twice. (HTML
comment: stripped from injection, so an unfilled template pays nothing for this block.) -->

<!-- Authoring outline - write these sections into the project-specific top of this file, in the
numbered order below, with ## Rules left last: a fixed order means every filled file keeps the same
fact in the same place, and the two highest-traffic facts (stack, commands) sit at the top. Keep
each section lean, then delete this comment block. Comments are stripped from injection, so this
outline costs nothing even while it sits here.

1. What this project is - one paragraph: domain, shape (binary / service / library), persistence,
   surfaces - plus a domain-terms map (business term -> code entity) wherever the two vocabularies
   differ, so a request in the business words lands on the right type.
2. Stack - languages, frameworks and key libraries at their EXACT versions ('EF Core 10', not
   'EF Core'), test stack + coverage gate, and the Open-VSX language-server extension for the
   primary language(s). Cursor has no /plugin install: language diagnostics come from extensions (on
   C# use a Roslyn-based one - Microsoft's C# Dev Kit is blocked here), and other capability from MCP
   servers or Cursor natives. MCP routing is NOT hand-filled here - it lives in the generated
   .cursor/rules/baseline-project-agent-capabilities.mdc (user-run /project-agent-capabilities; if
   that skill was not installed, a lean hand-filled routing list here is the fallback).
3. Commands - copy-pasteable build / test / run / migrate / publish, with any environment quirks - and
   beside the full-suite test command the SCOPED one (a single project, a test filter, a spec path)
   that iteration uses, so the whole suite runs once at the gate.
4. Architecture - the layers / modules and the dependency rules between them, with the why. Not the
   folder tour: a directory map is derivable, and the agent reads the tree itself.
5. Key patterns - the non-obvious in-house patterns a newcomer would trip on, and the forbid-list
   beside them: what this project does NOT use (a pattern, a library, a language feature), which no
   amount of reading the code makes obvious.
6. Operational notes - runtime constraints and gotchas that shape code decisions.
7. Cross-cutting checklists - for each change that must move several files in lockstep, the full touch-point list.
8. Secrets + config - where this project's secrets / env config live (the globs); mirror them into
   .cursorignore so they never reach the model - the stack expects only the generic .env* / key /
   cert shapes, never this project's own paths.
9. Code conventions - only where this project DEPARTS from the house-style skill the glob-scoped
   rules attach for that file type; a line that repeats the skill is a duplicate.
10. Testing approach - per-layer strategy, what's excluded, the integration / regression net.
11. Load by artifact - a table mapping this repo's concrete files / types / constructs to the skills
    that cover them but never fire on their own keywords (the house-style ones self-fire through the
    glob-scoped rules, so they are not in it).
-->

## Rules

The always-on baseline set in `.cursor/rules/`, all loaded every session. Glob-scoped rules in the
same directory attach on a matching file touch - their own `globs:` frontmatter says when.

In GENERATED rows, `user-run` marks a slash-only capture (`disable-model-invocation`): only the
user can invoke it, so name the command to the user rather than running it.

| Rule | What it governs |
|---|---|
| `.cursor/rules/baseline-interaction.mdc` | communication style, adversarial review of user proposals, formatting + privacy, planning/execution thresholds |
| `.cursor/rules/baseline-quality-gates.mdc` | code-quality bars, the done-claim verification gate, and claims about the outside world checked through context7 |
| `.cursor/rules/baseline-security.mdc` | security-review routing, PII/secret handling, the `.cursorignore` caveat |
| `.cursor/rules/baseline-git.mdc` | commits, branches, PRs, push discipline - the checkpoint protocol itself is the `project-commit-checkpoint` skill |
| `.cursor/rules/baseline-navigation.mdc` | symbol-lookup and code-reading discipline, and what a summarization must keep verbatim |
| `.cursor/rules/baseline-docs-root.mdc` | the generated-docs root - the installer-stamped path `<docs-path>` resolves to, and that every generated doc lives under it |
| `.cursor/rules/baseline-project-agent-capabilities.mdc` (GENERATED - user-run /project-agent-capabilities after install, update, or a trim) | the usage policy plus this project's real skill / seat / MCP inventory |
| `.cursor/rules/baseline-project-architecture.mdc` (GENERATED - user-run /project-architecture-analyzer) | architecture awareness - the micro-summary plus the read-the-map trigger into `<docs-path>/architecture/` |
| `.cursor/rules/baseline-project-related-context.mdc` (GENERATED, OPTIONAL - only where the project has sibling repos; user-run /project-related-context with their paths/URLs, else delete this row) | sibling-repo awareness - name / location / relation / seam per sibling |
| `.cursor/rules/project-code-style.mdc` (GENERATED - user-run /project-code-style-analyzer; glob-scoped, plus the full doc) | the project's actual code style - the condensed core auto-attaches on any matching file touch (main session and subagents); the full capture stays in `<docs-path>/PROJECT-CODE-STYLE.md` |
