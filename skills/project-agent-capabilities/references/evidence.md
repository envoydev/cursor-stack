# project-agent-capabilities - evidence appendix

The measured anecdotes behind this skill's rules, kept out of the run-time body so every session stops paying
for them. Audit material: read it to learn WHY a rule is shaped the way it is, never to run the skill.

## The script (scripts/capabilities-inventory.js)
- **What is a COMMAND holds, what is PROSE slips** - measured across 154 session bundles: this
  skill's PRECHECK, the one step that was a command, ran in 26 of 26 runs; the prose step right
  after it slipped in 8 of 26. That split is why the mechanical half is a script now.
- **One node pass, never a fork per skill** - measured: the shell extractor loop took 4m13s on Git Bash.
- **The frontmatter check is node, never PyYAML** - measured: a run's verify step died on
  ModuleNotFoundError and the close still reported 'frontmatter parses'.
- **Rules are read as `.mdc` with `globs:` / `alwaysApply:`** - the peer stack's `paths:` key does
  not exist here, and a scanner that looked for it reported every rule pathless.
- **No `first call:` line in a Cursor rule** - Cursor exposes MCP tools directly, with no deferred
  loading step, so the row names the server and its routing and stops there.

## 0. PRECHECK
- **Empty output - say so in ONE line and STOP** - measured: the skill re-ran the full inventory whether or not anything had changed and reported 'unchanged from the previous capture' only AFTER paying for it - 44 runs across a nine-project collection, with 12 project-days carrying more than one run and one pair 18 minutes apart.

## 1. INVENTORY
- **Skills: EXTRACT the three fields - never dump the frontmatter** - measured: 84.1KB spilled and 30,828 B re-read, against 2,727 chars for the extractor - four runs paid this, one of them ~96.5k tokens.
- **MCP servers: the file is not the whole inventory** - measured: a run that inventoried the file alone wrote 'no issue-tracker connector is registered' into the always-on rule while 41 Jira/Confluence and 42 Notion tools were live in that same session.
- **Any Bash in this step uses absolute paths or a subshell** - measured: an inventory's bare `cd` into the config dir left the shell there for ~7 minutes of follow-on commands until the user redirected.

## 2. GENERATE
- **COMPOSE the whole body, then compare - the write is always the whole file** - measured: an upsert run silently missed a new usage-policy bullet.
- **Identical? Do not write.** - measured: two projects and four runs produced a byte-for-byte identical rule (one pair 7,582 bytes, zero delta) and each still paid a delete plus a full write, and the next session paid the changed mtime.

## Usage policy (the stamped block)
- **A deliberate orchestration skill starts in a fresh session** - measured: chaining 6-8 such runs in one chat tripled the per-message context, and one post-idle question alone re-paid 465k tokens of cache rebuild.

## Generated rule - fill rules (references/generated-rule-template.md)
- **Orchestration row: the first CLAUSE, max 120 chars** - measured on a 16-seat project: house first sentences run 460-588 chars, so 'the first sentence' put 4,594 chars of orchestration block into a rule every session and every subagent pays for.
- **playwright: a full-page PNG Read is for the FINAL accepted state only** - measured: two sessions Read ~260k tokens of full-page PNGs while iterating styling, then re-paid them as cached context every turn after; the evaluate/snapshot sessions verified the same class of change for under 10k each, and a target-scoped read cost 0.6k where the full page cost 22k.

## 3. REPORT
- **A literal line template, not prose to remember** - measured: the prose form of these lines lost in 2 of 2 audited runs with the text loaded.
- **Every count comes from the command that produced the list** - measured: four audited sessions miscounted the seats, every one of them off by one and every one of them LOW (17 vs 18, 18 vs 19, 21 vs 22).
- **`Live from:` and `Next run:` are UNCONDITIONAL** - measured: a first-act run that recommended nothing chained a second orchestration run 3 minutes later and wrote off 205.9k tokens before the user killed it by hand.
- **Say the `Live from:` line the one way it is true on both branches** - measured: the un-scripted version got it wrong in 4 of 5 audited runs - two called a first-act session 'mid-session', and one told the user a rule written 90 seconds in was 'live for the rest of it'.
- **`Next run:` names no skill** - changed 2026-09-14: filled from 'the command they named', it named `/project-agent-capabilities` itself after a run the user had just typed, and the user ruled that a skill is suggested only when its output is stale. The line stays as a fresh-chat note because Cursor has no fresh-session hook (measured: a session wrote the rule at minute 2, then chained three more orchestration runs, every context spike landing above 320k).
- **Two flags are MECHANICAL - compute them, never eyeball them** - measured: the prose form was missed by a run that had the evidence in front of it.
- **(a) intersect the MCP config against the heavy-native-deps list** - measured: a run with `appium-mcp` registered closed with 'Nothing odd to flag'.
- **(b) list the rules dir and report a seat family with no convention rule** - measured: a run asserted that cross-check having never listed the directory.
- **Never assert WHY something is installed or disabled** - measured: a confidently wrong causation claim - the plugin belonged to a sibling repo - cost a user challenge plus 5 corrective calls.
- **The rule is MACHINE-LOCAL, not committed** - measured: the older text claimed the opposite; a session checked `git check-ignore` and found the contradiction.
