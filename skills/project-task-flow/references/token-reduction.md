# Token-Reduction Policy - Ponytail and report terseness

Token reduction is a policy, not ad-hoc instructions repeated in every agent. Two disciplines do different jobs: Ponytail cuts unnecessary work and code (the big lever); report terseness cuts output verbosity (a smaller, selective lever). Ponytail ships as a plugin AND as the inline discipline named in each body; report terseness is inline-only - it was the Caveman plugin until measurement showed that plugin's SessionStart hook never fired inside a dispatched seat (so it saved nothing in a multi-subagent flow while adding its descriptions to every context), so the plugin was dropped and only the inline discipline - baked into the report / punch-list seats - remains.

## Ponytail - the primary lever

Ponytail is primary because it reduces the work itself, not just the words. Run it at full discipline for the seats that write or judge code, lite for the seats that plan.

```yaml
ponytail:
  implementers: full
  repair_agents: full
  domain_verifiers: full        # the 'review' discipline: hunt over-build past the plan
  solution_designers: lite      # the 'ultra' discipline: smallest plan that fully meets the requirement
```

Core Ponytail behavior expected from an implementer (the 'full' discipline):

```text
1. Do not write code if configuration, existing code, or deletion solves it.
2. Search for an existing pattern before adding a new abstraction.
3. Prefer a framework / native / stdlib feature before a new dependency.
4. Implement the smallest change that satisfies the contract and acceptance criteria.
5. Do not future-proof speculatively.
6. Record each deliberate simplification and its ceiling/upgrade path in the closing report ('global lock, per-account locks if throughput matters') - never as a `ponytail:` code comment; markers stay out of the code, the report carries the intent.
7. Never cut security, accessibility, validation, data-loss prevention, or migration safety to get smaller.
```

Verifier / reviewer Ponytail checks (the 'review' discipline):

```text
Did the seat overbuild? Add an abstraction with one caller? Add a dependency
where the framework/BCL already ships one? Duplicate an existing utility?
Change more files than the task required? Can the diff shrink without losing
correctness or safety? Over-build past the plan is a finding; re-opening scope
the plan deliberately included is the designer's call, not the verifier's.
```

This is why each seat already names its discipline inline - designers 'ultra', implementers and repair resolvers 'full', verifiers 'review'. The integration-reviewer runs NO ponytail pass - over-build is already hunted per stack by the domain verifiers; it carries report-lean only. This policy is the shared statement of why.

## Report terseness - selective only

Report terseness mainly shrinks output tokens. It does not reduce file reads, tool output, reasoning, or repeated context, so it is a tail-trim, not a primary lever. Apply it only where output volume is real and readability is not at a premium.

Good uses: compact implementer final reports, verifier and integration punch-lists, repair-agent summaries, commit messages, and PR comments.

Avoid terseness for: BA requirements clarification, cross-stack contract output, project-solution-design docs, security-audit reports, final architecture decisions, and Contract Change Requests - anything that must stay highly readable. Those are the high-readability seats that carry NO terseness line; the report / punch-list seats carry the inline 'Report lean.' discipline in their bodies.

**Mechanism note (measured):** report terseness is a discipline each seat applies INLINE in its own final report - hand back byte-exact code and a compressed explanation - the same inline-discipline model Ponytail uses ('full' / 'review' named in each body). It was the Caveman plugin, but that plugin was a main-session SessionStart hook that did NOT fire inside a dispatched seat (whose report comes back in full prose), so in a multi-subagent flow it saved nothing while adding its skill descriptions to every context - net-negative, and dropped. The inline discipline is the whole of what it contributed, and it stays. Keep the ceiling honest: terseness only shrinks the report's words, never the seat's input context, tool output, or reasoning - which dominate its token count - so the mode ladder (fewer seats) and capability-reuse (leaner context) are the levers that actually move seat tokens; this one trims the tail.

## Combined configuration

```yaml
token_reduction_policy:
  ponytail:
    implementers: full
    repair_agents: full
    verifiers: full
    designers: lite
  report_terseness:            # inline discipline in each report / punch-list seat (was the Caveman plugin, now dropped)
    reports: lite
    punch_lists: lite
    commit_messages: lite
    pr_comments: lite
    contracts: off
    solution_design: off
    security_audit: off
```

## The third lever - eager context and redundant reads

Ponytail cuts the work, report terseness cuts the words; the third lever cuts the context a seat loads - load only the certain-use skill or MCP, navigate with serena, reach for context7 before a library API, and let a verifier orient from the implementer's memory note plus the diff instead of re-reading the whole module. The per-role wiring and the mechanisms live in `capability-reuse.md`, which also holds the safety floor: the verifier still runs the gates independently and never trusts the note in place of running the gate.

## The fourth lever - quiet the command output

The tool's own output is context you pay for, so run every gate at minimal verbosity rather than letting it stream a wall of text: `dotnet test -v minimal` (or `--logger "console;verbosity=minimal"`), `nx <target> --output-style=static`, `tsc --pretty false`, `git --no-pager status --short`. Then window a failing log to the first real error instead of pasting the whole run - the evidence-gatherer already does this for the diagnosers, and any seat running a build / test / lint gate should do the same. This is a cheaper, dependency-free version of a shell-output compressor: cut the noise at the source instead of filtering it after.

## The fifth lever - the session model

Cursor runs every seat on the session model: the agents are `model: inherit` and carry no effort pin, and there is no per-dispatch override. So the session model is not one lever among many - it is the only model lever, and it applies to the orchestrator and every seat it dispatches alike.

That makes the choice a single trade rather than a tuning exercise: a run whose expensive judgment is design (a cross-domain decomposition, an architecture capture) wants a session model you would trust with design, because the designer cannot be raised independently of the routing. A run that is mostly mechanical build-out does not, because nothing in it needs the headroom. Pick once, at launch, for the heaviest judgment the run actually contains.

Everything else in this file is the real lever, and none of it depends on the model: fewer seats (per `references/execution-modes.md`), lean briefs, minimal gate verbosity, and windowed logs.

Never let Ponytail minimalism or report terseness cut a security check, validation, authorization safeguard, audit log, migration safety, or data-loss protection. Smaller is a means, not a license.
