---
name: project-code-style-analyzer
description: "The deliberate project code-style capture: fan out code-style-analyzer agents (one per detected language), merge their reports into docs/PROJECT-CODE-STYLE.md, and generate the glob-scoped rule .cursor/rules/project-code-style.mdc that surfaces that doc at edit time, scoped to the exact file extensions the agents observed. Re-run to refresh: the same analysis, the doc reconciled in place and the rule regenerated from the fresh extension union. Manual, /-only. Triggers on 'capture the project code style' or 'set up the code-style doc and rule'. NOT for architecture (project-architecture-analyzer), one language's style question (@agent-code-style-analyzer alone), or enforcing style (the per-language configs stay the enforced source)."
disable-model-invocation: true
---

# Project Code Style Analyzer - Capture, Merge, Attach (Deliberate)

You drive the deliberate capture of a project's ACTUAL code style and make it self-serving at edit time. Two artifacts come out of a run; a re-run repeats the same analysis, then reconciles the doc in place and regenerates the rule from the fresh extension union:

1. `docs/PROJECT-CODE-STYLE.md` - the merged style doc: how this codebase really writes each of its languages (config-enforced rules + the idioms a linter cannot encode), divergence from the house convention skills flagged. Written under the project's configured docs root (default `docs/`, per the project's AGENTS.md).
2. `.cursor/rules/project-code-style.mdc` - a generated glob-scoped rule that points at that doc, scoped to the exact file extensions the analysis observed - so the style is in front of whoever edits one of those files, without anyone remembering to open a doc. This is a rule, NOT a hook: Cursor auto-attaches a matching `.mdc` by glob as soft guidance, and hooks are the home of deterministic gates only (a code-style nudge must never block an edit).

The per-language configs (`.editorconfig`, eslint/prettier, `tsconfig`, the SQL linter rules) stay the enforced source of truth; the doc records what they encode and what they cannot. Code style is NOT architecture - structure, boundaries, and patterns live in `docs/architecture/`, owned by the project-architecture-analyzer skill. Never fold one into the other.

## Execution modes
DELEGATED vs INLINE - and why detection keys on dispatch capability, not file presence - is the shared policy `project-task-flow` owns. Pick once, hold for the run:

- **DELEGATED** (dispatch available) - fan out code-style-analyzer per language as below; you merge and write.
- **INLINE** (no dispatch available, or a single-language repo too small to fan out) - do the same characterization in-session, one language at a time, honoring the agent's own rules (config first, located code second, 2 locating passes per language, divergence flagged) - then continue at MERGE identically.

## The run

### 1. DETECT - what languages does this repo hold?
A cheap Glob scan, in-session: `*.cs`, `*.xaml`, `*.ts`, `*.html`, `*.scss`/`*.css`, `*.sql`, plus the config markers (`package.json`, `angular.json`, `*.csproj`, `tsconfig.json`, `.editorconfig`, eslint/prettier config, SQL linter config). The result is the fan-out list - one language family per seat (e.g. WPF repo: C# + XAML; Angular repo: TypeScript/Angular + SCSS/CSS; ASP.NET repo: C# alone). Do not dispatch for a language the scan did not find.

### 2. FAN OUT - one code-style-analyzer per language, in parallel
Dispatch all seats in a single message. Each dispatch prompt names its language-family scope and nothing else - the agent reads its config + representative code and returns the structured report (project type, observed extensions, enforcement map, enforced rules, idioms, uncertain/inconsistent). The agents write no files; their final messages are your merge input.

### 3. MERGE - write docs/PROJECT-CODE-STYLE.md (the project's configured docs root, default `docs/`)
Consolidate the reports into one doc - apply the `markdown-style` skill so it reads as a quick reference, not a wall of prose. Shape:

1. One opening line - the project's actual style; configs stay enforced; this captures what they cannot; where this doc and a house convention skill disagree, THIS doc wins.
2. **Project type** - the consolidated verdict from the seats' evidence.
3. **Enforcement map** - one table across languages: language -> config file(s) -> what runs them.
4. **Per language** - each seat's Enforced + Idioms sections, merged faithfully: keep every 'uncertain'/'inconsistent' marker, never smooth one over, and keep the divergence-from-house-skill flags - they are the useful signal.
5. **Cross-cutting idioms** - what spans languages: file/folder organization, test structure and naming, comment density.

Re-run: reconcile the existing doc against the fresh reports - correct what drifted, add what is new, drop what is gone.

### 4. RULE - regenerate .cursor/rules/project-code-style.mdc
Build the extension union from the agents' **Language + extensions** sections ONLY - never pad it from assumption (a WPF repo gets `cs`/`xaml`, an Angular repo `ts`/`html`/`scss`, an ASP.NET repo `cs` - plus whatever else was genuinely observed, e.g. `sql`).

The rule is fully derived, so regenerate it WHOLESALE each run - no upsert, no hand edits to preserve. Write `.cursor/rules/project-code-style.mdc` (create `.cursor/rules/` when absent) as a valid Cursor rule: `globs` is the comma-separated `**/*.<ext>` list built from the union, `alwaysApply` is false (it attaches on a match, and only then - an always-on copy would tax every session for a doc most turns never need). Keep the body to a pointer, never a copy of the doc - the shape:

```markdown
---
description: Project code-style awareness - generated by /project-code-style-analyzer; edit via a re-run, not by hand.
globs: "**/*.cs,**/*.xaml"
alwaysApply: false
---

Before writing or editing one of these files, read `docs/PROJECT-CODE-STYLE.md` - it records how
THIS codebase actually writes each of its languages: the config-enforced rules and the idioms a
linter cannot encode. The per-language configs stay the enforced source of truth; this doc records
what they encode and what they cannot. Soft guidance - it never blocks an edit.
```

Point the body's doc path at the project's configured docs root (per its AGENTS.md) when that is not the default `docs/` - unlike a hook, a rule is prose the agent reads, so the path just needs to be correct in the text.

**Verify what you generated before trusting it:** the frontmatter must parse as YAML (a malformed block silently drops the rule), `globs` must cover exactly the observed union, and the doc path in the body must resolve to a real file. This rule is per-project output, deliberately NOT in the stack installer's RULES manifest - the installer fetches only named files and prunes nothing in `.cursor/rules/`, so `stack update` never touches it.

### 5. REPORT
Confirm both artifacts (doc created/refreshed + sections touched; rule regenerated, with the glob union). Then briefly: the languages detected, the notable idioms a linter cannot enforce, and any divergence from the house skills worth attention. Both artifacts are committed files - remind the user they ship with the repo. No re-paste of the doc body - point to the file.

## Don't game it
The doc records the style the code actually follows, not an aspiration - the agents' rules bind the merge too: every idiom names observed code, splits stay 'inconsistent', absent conventions stay absent. The hook filter is derived, not designed - extensions come from the reports, and the verify step in HOOK runs against the real generated file, not the template.
