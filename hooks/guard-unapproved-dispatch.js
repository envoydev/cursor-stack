#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// subagentStart gate: the approval gate for implementer fan-out.
//
// An implementer dispatch is the expensive, hard-to-reverse step of a build flow - it runs
// only after the user's explicit approval (or an explicit 'run without stops' waiver),
// recorded as a gate file the flows write. Prose approval gates measured unreliable on the
// peer stack (they collapse on an ambiguous 'go'), so this turns the gate into a file check
// the dispatch cannot pass without. Designers pass (they produce the plan BEFORE approval
// exists) and verifiers pass (read-only audits; plan audit dispatches one pre-approval).
//
// Scope, stated honestly: Cursor's subagentStart reports subagent_type as its own fixed kind
// (generalPurpose / explore / shell), NOT the name of the .cursor/agents seat being run - so
// the seat cannot be read from the type. This keys on the dispatch `task` text instead, which
// is where a flow names the seat it is fanning out to. A dispatch whose task names no
// implementer seat passes untouched, and `explore` is read-only so it always passes. That
// makes the gate narrower than the peer's name-keyed one: it catches the flows' own dispatches,
// not an arbitrary hand-written one that never names its seat.
//
// Stamp lifecycle: each flow writes its OWN stamp when its consent lands and clears it at run
// end; a stamp persists across a flow's resumed sessions until that clear. Stamps older than
// MAX_STAMP_AGE_MS are treated as absent - a leftover stamp from a finished flow silently
// authorized three later, unrelated runs' dispatches in one audited project.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_STAMP_AGE_MS = 8 * 60 * 60 * 1000; // 8h - re-stamping is one write; staleness shipped unapproved dispatches

function respond(body)
{
    process.stdout.write(JSON.stringify(body));
    process.exit(0);
}

const allow = () => respond({ permission: 'allow' });

function main(payload)
{
    // explore is read-only by construction - it can never be the implementer fan-out.
    if (payload.subagent_type === 'explore')
    {
        allow();
    }

    const task = String(payload.task || '');
    const seatMatch = task.match(/\b([a-z][a-z0-9-]*-implementer)\b/);
    if (!seatMatch)
    {
        allow();
    }

    const seat = seatMatch[1];
    const root = (payload.workspace_roots || [])[0] || process.cwd();
    const docsRoot = process.env.CURSOR_DOCS_PATH || '.cursor/docs';
    const gate = path.resolve(root, docsRoot, 'flow', 'APPROVAL');

    let first = '';
    let stale = false;
    try
    {
        const stampMs = fs.statSync(gate).mtimeMs;
        const age = Date.now() - stampMs;
        // A stamp written BEFORE this session started records another session's decision, and the
        // age cap alone let one through: five implementer dispatches ran on a stamp a different,
        // already-closed session wrote 2h52m earlier - inside the cap, so the gate saw consent this
        // run never gave (measured). The stamp is the dispatching session's own or it is not consent.
        let sessionStartMs = 0;
        try
        {
            sessionStartMs = fs.statSync(String(payload.transcript_path || payload.conversation_path || '')).birthtimeMs || 0;
        }
        catch
        {
            sessionStartMs = 0;
        }

        if (age > MAX_STAMP_AGE_MS || (sessionStartMs && stampMs < sessionStartMs))
        {
            stale = true;
        }
        else
        {
            first = fs.readFileSync(gate, 'utf8').split('\n')[0].trim();
        }
    }
    catch
    {
        // absent or unreadable - no approval recorded
    }

    if (/^(APPROVED|AUTO)\b/.test(first))
    {
        allow();
    }

    const why = stale
        ? `the approval stamp at ${gate} is older than 8h and is treated as absent (a stale stamp from an earlier flow is not consent for this run).`
        : 'no approval gate is recorded.';

    respond({
        permission: 'deny',
        user_message: `Blocked a dispatch of ${seat} that has no recorded approval.`,
        agent_message: `Blocked: dispatch of ${seat} - ${why} `
            + 'Implementer fan-out runs only on the user\'s explicit approval, or their explicit \'run without stops\' waiver - never on an '
            + `inferred or ambiguous go-ahead. If the user gave one THIS conversation, write ${gate} with one first line - `
            + 'APPROVED <plan/contract id> - "<their words, verbatim>" (or AUTO - "<their words, verbatim>" for a no-stops run) - then retry '
            + 'the dispatch. Never fabricate the quote. Otherwise: present the plan and ask the user - that stop IS the recovery path. Do NOT '
            + 'route around this gate by doing the seat\'s build work inline instead: a blocked dispatch means the flow is missing its approval, '
            + 'not that the flow should be abandoned. Clear the file when the run completes.',
    });
}

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () =>
{
    try
    {
        main(JSON.parse(input));
    }
    catch
    {
        allow(); // can't parse hook input -> don't block on a harness malfunction
    }
});
