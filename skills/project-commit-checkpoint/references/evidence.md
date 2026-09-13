# Evidence appendix - what each receipt line was added to catch

An audit appendix, not a run-time load: read it when a rule in SKILL.md looks like ceremony, never
as part of a commit.

## The five receipt lines

Each line closed a measured way the receipt passed while recording nothing.

- `VERIFIED` - the review ran. A self-written VERIFIED receipt once cleared a commit no user had
  requested.
- `authorized:` - the user asked for THIS commit, in their own words. The quoted words must carry a
  commit verb: `authorized: "what time is it?"` used to pass.
- `head:` - the review ran against THIS tree.
- `spec:` - it covered the whole diff. One receipt asserted a 17-file review in which 9 files had
  been read.
- `live-probe:` - it ran the thing. One asserted a passing review with no build or test output at
  all.

## Why the review must really run

A receipt claiming 'project-verify-code inline' with no review run in the chat was measured twice.
The formatter half: one file edited during review and committed on a stale 'I ran it earlier' broke
CI's format check and cost a fixup commit.

## Why the receipt is its own tool call

The shipped hook accepts the atomic write+commit shape, so only the rule binds: 9 of 13 commits in
one audited session took the atomic shape, and two of those left the receipt uncleared. A batch
receipt was also left uncleared after 4 commits. The absolute path exists because a relative write
followed a drifted shell directory and the gate read an absent receipt.

## Why a hook, and why publishing is gated too

8 ungated commit events across 6 audited sessions rode on prose alone. Before the publish half
existed, every push and merge across four audited sessions passed every guard - one published
unpushed commits 18 minutes before any receipt existed, another put 40 files on a shared `develop`.
