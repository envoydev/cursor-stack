---
name: project-agent-capabilities
description: "The deliberate capabilities capture. Use when the user asks to capture the project capabilities, refresh the capabilities rule, or find out what this project has installed - and after an install, a stack update, or a manifest trim. Manual, /-only. It inventories what THIS project actually has - the slash-only orchestration skills, the subagent seats, the MCP servers - and regenerates wholesale the always-on awareness rule .cursor/rules/baseline-project-agent-capabilities.mdc: the fixed house usage policy plus the real inventory, never an assumed stack. NOT for capturing architecture (project-architecture-analyzer), code style (project-code-style-analyzer), or a sibling repo's context - that is the sibling-context capture, where the project installed one."
disable-model-invocation: true
---

# Project Capabilities - inventory what is installed, generate the awareness rule

Every project trims the stack differently - skills commented out of the manifest, MCPs dropped (`memory` in a standalone project, `angular-cli` outside Angular), seats it never installed. A predefined list would name capabilities the project does not have; this skill reads the REAL inventory and generates the rule from it, so every session knows exactly what this project can do - and never gets steered at a capability that is not there.

The measurements behind these rules live in `references/evidence.md` - an audit appendix, not a run-time load.

## The run - one script, one compose, one write

`scripts/capabilities-inventory.js` does every mechanical step in ONE node pass (built-ins only,
nothing to install, no per-skill fork): the precheck, the inventory with a printed COUNT per layer,
the registered MCP servers, the paste-ready MCP routing rows, the compare verdict and the
post-write verify. From the project root:

```bash
node .cursor/skills/project-agent-capabilities/scripts/capabilities-inventory.js
```

**Its printed block is the whole inventory.** Re-grepping, re-reading or hand-tallying anything it
printed is a defect, not diligence - every count and every row of the report comes off one of its
lines, and a claim with no printed line behind it does not go in the report. It never launders a
failure into an empty result (`<cmd> || echo none`, banned in `baseline-navigation.mdc`) and never
pipes through `| head -N`, so 'unreadable' and 'zero' stay different report fields.

One thing the script cannot read, and the one place you still look yourself: the LIVE MCP side.
Cursor ships no MCP list command, so the script reports what `.cursor/mcp.json` registers and says
so; the servers whose `mcp_<server>_` tools this session actually shows are visible only to you.
Check them before any 'not registered' claim - a server configured at the user level has no row in
that file.

### 1. PRECHECK - the script's first lines
- `PRECHECK: FIRST` - no rule yet. Compose and write; this is the capture the skill exists for.
- `PRECHECK: empty` - nothing under the inventory sources changed since the rule was written. Say
  so in ONE line naming the `Captured:` date that line quotes, and STOP. Do not compose, do not
  write. Two things the precheck cannot see, and the only two reasons to go on: an MCP server
  configured outside this tree (the user-level config changes no file here), and the USER may ask
  for a refresh outright. Either overrides it - say which one you are acting on.
- `PRECHECK: drift - <n> file(s)` - that is the drift. Continue, and name those paths in the report.

### 2. COMPOSE the body - the verdict authorizes the write
Read `references/generated-rule-template.md` for the four sections' fill rules, then compose the
WHOLE body in-session: the block below verbatim, with only its `<...>` slots filled from the
script's lines. One slot is not a slot - every `<docs-path>` becomes the LITERAL `DOCS ROOT` value
the script printed, because the generated rule is a deterministic pointer and cannot itself carry
the placeholder it exists to resolve.

The rule is a valid ALWAYS-ON rule: `alwaysApply: true` is the only thing that pins a rule into
every session, and a `description:`-without-globs block is advisory and may never attach.

Write the composed body to a scratch file, then run the verdict:

```bash
node .cursor/skills/project-agent-capabilities/scripts/capabilities-inventory.js --body <that file>
```

- `COMPARE: identical` - do NOT write. Report `rule unchanged - <N> bytes, not rewritten`, and go
  to step 3's report. An identical rewrite pays a full write for nothing, and the next session pays
  the changed mtime.
- `COMPARE: differs` - write the composed body over the rule in ONE call, the whole file. No
  in-place edit, no `sed -i`, no partial upsert: an edit keeps stale policy wording the skill has
  since changed. No delete first - one round trip.

Without a printed `COMPARE: differs` line there is nothing to write.

This skill was renamed from project-capabilities: when a legacy `.cursor/rules/baseline-project-capabilities.mdc` exists, delete it in the same run - this rule supersedes it, and nothing else ever prunes generated rules. Keep it lean (always-on tokens are paid every session and subagent).

The block below is a COPY TARGET, not prose to retype: take it verbatim and fill only the `<...>` slots, per step 2. The REPORT's `Template:` line is the receipt that `references/generated-rule-template.md` was read. The shape:

```markdown
---
description: Project capabilities awareness - generated by /project-agent-capabilities; edit via a re-run, not by hand.
globs:
alwaysApply: true
---

# This project's capabilities

Captured: <YYYY-MM-DD> from <stack version>@<short-sha> (the install stamp's, or `no stamp` when absent)

## Usage policy (fixed - stamped verbatim, every run)
- Load a skill for the work at hand - a file you're about to edit, a command you're about
  to run, a diff you're about to show - never to answer a question. Over-loading a simple
  turn is the failure to avoid.
- One home per rule: route in the project's AGENTS.md only what an auto-injected
  description does not already cover. Path-scoped rules own per-file-type routing; hooks
  own deterministic gates and announce their own blocks - add a new gate as a hook, not prose.
- Subagent dispatch is explicit, never automatic: a user @agent-<name> mention, an
  orchestration skill routing to it, or a path-scoped repair-loop rule naming its resolver.
  Never self-delegate off a description match. When a task calls for multi-agent work,
  suggest the matching orchestration skill from the inventory below - never one this
  project does not carry.
- Memory recall is historical, not current: the assistant's per-project auto-memory
  persists across installs and roster changes. Validate any seat, skill, or command a
  recalled memory names against this rule's inventory before acting on it - a recall
  can name a capability this project no longer carries.
- A slash-only skill (`disable-model-invocation` - the ones listed below) is the USER's to
  type - never run it yourself, and never replay its protocol from memory instead. Never
  attempt one, never retry it under another spelling, and never spend the turn explaining
  that you cannot or weighing whether to: name the command, say in one line what it will
  do, hand the turn back.
- A deliberate orchestration skill (a capture, a quality loop, a build flow) starts in a
  fresh session when this one already carries another skill run's history: name the
  fresh-session route in one line before invoking (measured: chaining 6-8 such runs in
  one chat tripled the per-message context, and one post-idle question alone re-paid
  465k tokens of cache rebuild).
- Every doc the assistant creates lands under the docs root (`<docs-path>`), in its owned
  folder: `architecture/`, `test-coverage/`, `loops/` - and `related-projects/` for the
  sibling-repo orientation doc (`related-projects/RELATED-PROJECTS.md`), with the plain folder
  `related-context/` alongside it for every OTHER sibling-repo doc (cross-repo plans, change
  requests, issue notes, run recipes; look there before re-deriving sibling state). A doc outside
  the root takes the user's approval, asked first - never silently.

## Orchestration skills (slash-only - invisible until invoked)
<one ROUTER row per slash-only skill: `/name - <first clause, max 120 chars>`>

## Subagent seats
<one line: the installed seat names, comma-separated>

## MCP routing
<one row per REGISTERED server, from the routing map>
```

Verify after writing: the frontmatter parses, it carries `alwaysApply: true`, and every inventory row came from the step-1 read of disk. Report the result on the `Rule:` field - a rule that does not parse is a rule no session loads.

The usage-policy section is the house skill/agent policy's ONE home - it ships verbatim from this skill (a policy wording change lands here and reaches projects on their next re-run). Like every generated `baseline-project-*.mdc` rule it stays out of the installer's fetch manifest, so a stack update cannot overwrite it.

### 3. REPORT
A literal line template, not prose to remember - the close is filled in, field by field:

```
Rule:       <created | refreshed | unchanged, not rewritten> - <N> bytes
Template:   read - references/generated-rule-template.md
Inventory:  skills <n> / seats <n> / MCP servers <n>
Drift:      <the paths the precheck printed, or `user asked for a refresh` / `user-level MCP only`>
Live from:  next session - an always-on rule is read at session start, so it does not govern this one
Next run:   start any next deliberate run in a FRESH chat
Flags:      <one row each, or `none`>
```

Every count comes from the command that produced the list, never from a hand tally. Pipe the inventory through `wc -l`, or quote the number the listing printed.
`Live from:` and `Next run:` are UNCONDITIONAL and identical on both branches - a rule is read at
session start either way, and the first-act session is the one most likely to run something else
next. `Next run:` names NO skill - never this one, which just ran, and never another by default: a
capture is suggested only where its output is stale. Cursor has no fresh-session hook, so this
line is the only guard against chaining a second deliberate run into this chat. The FIRST-ACT test itself stays mechanical - this run was NOT the session's first act when a
user message, a tool call or another skill run precedes it in the chat - and it is now only a
detail in the sentence, not a branch that changes what is owed.

Then the prose, short - four things, each its own line so none of them is skimmed past:

- **Say `Live from:` the one way it is true on BOTH branches** - an always-on rule loads at session start, not retroactively, so this one governs from the next session and its guidance starts applying in the next fresh chat.
- **Two flags are MECHANICAL - compute them, do not eyeball them**: (a) intersect the parsed `.cursor/mcp.json` names against the heavy-native-deps list {`chrome-devtools`, `appium-mcp`} and report every hit as its own row; (b) `ls .cursor/rules/` in step 1 and report any seat family with no matching convention rule. Also flag a slash-only skill whose seats are not installed.
- **Never infer causation you cannot observe** - state observed facts plainly, and never assert WHY something is installed or disabled: Cursor exposes no per-project plugin inventory, so install-scope causation is unknowable from inside a session, and a confident guess is the measured failure mode.
- **Say that the rule is MACHINE-LOCAL, not committed** - the installer tells every project to gitignore `.cursor`, so this file is untracked, a fresh clone does not carry it, and the command has to be re-run there.

## Don't game it
The rule lists what the inventory proved, nothing else - no capability is assumed from the house defaults, no row survives for a server or skill the project dropped, and an unreadable source (a malformed frontmatter, a missing `.cursor/mcp.json`) is reported as unreadable, not filled from memory. If the inventory looks wrong (an empty skills dir in a stack-installed project), say so and stop rather than generate an empty rule over a good one.
