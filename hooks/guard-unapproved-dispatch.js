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
//
// Symbol-search rule: a SYMBOL question - who calls this, where is it declared, what type resolves
// here - is never delegated to the grep-shaped `explore` seat. It answers by name-match, so
// baseline-navigation's 'locate with serena, inline' never reaches it (measured on the peer stack: a
// C# symbol hunt handed to a search seat came back as grep hits). Blocked regardless of any stamp; a
// broad multi-file sweep with no symbol question in it still passes.
//
// NOT ported, and why: the peer stack also blocks a GENERIC seat while a flow is stamped, and sends a
// symbol question on a generic seat back to serena. Both key on the seat's type telling a named
// domain seat from a generic stand-in, and Cursor's `generalPurpose` is both - a flow's own named
// seat can arrive as that type - so either rule here would block the flows' own dispatches.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_STAMP_AGE_MS = 8 * 60 * 60 * 1000; // 8h - re-stamping is one write; staleness shipped unapproved dispatches
// The docs root env value - where the approval stamp and the block ledger live.
const docsRootEnv = () => process.env.CURSOR_DOCS_PATH || '.cursor/docs';
let payload = {};

function respond(body)
{
    process.stdout.write(JSON.stringify(body));
    process.exit(0);
}

const allow = () => respond({ permission: 'allow' });

// --- block telemetry (shared by every guard hook; keep the copies identical) ------------
// A block costs a whole turn - the reason goes back to the model and the work is re-done - so a
// FALSE positive is 10-100x the cost of the gate itself, and until this existed the block rate was
// the one number the stack could not measure. One JSONL row per block, written under the docs root
// so one reader can tally every guard. Best-effort in every direction: telemetry never changes the
// verdict and never throws.
function ledger(event, reason)
{
    try
    {
        const root = (payload.workspace_roots || [])[0] || process.cwd();
        // resolve, NOT join: an ABSOLUTE CURSOR_DOCS_PATH makes path.join('/a/b','/x/y') into
        // '/a/b/x/y', so every ledger row lands in a doubled path that nothing reads. resolve
        // honours an absolute value and still joins a relative one.
        const dir = path.resolve(root, docsRootEnv(), 'hook-blocks');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${payload.session_id || 'nosession'}.jsonl`), JSON.stringify({
            ts: new Date().toISOString(),
            hook: path.basename(__filename),
            event,
            tool: 'subagent',
            reason: String(reason).split('\n')[0].slice(0, 200),
        }) + '\n');
    }
    catch { /* telemetry is never allowed to break the gate */ }
}

function deny(userMessage, agentMessage)
{
    ledger('subagentStart', agentMessage);
    respond({ permission: 'deny', user_message: userMessage, agent_message: agentMessage });
}

// The QUESTION shapes baseline-navigation names, not tool words - a sweep brief ('map the auth
// module', 'which files configure logging') carries none.
const SYMBOL_QUESTION = new RegExp(
    [
        'who calls\\b',
        'call(?:ers|[- ]sites)\\s+(?:of|for)\\b',
        'where\\s+(?:is|are)\\s+\\S.{0,60}?\\b(?:defined|declared|implemented|instantiated|registered)\\b',
        '\\b(?:find|locate|get)\\s+(?:the\\s+)?(?:definition|declaration|implementation|signature|body)\\s+of\\b',
        '\\breferences?\\s+to\\b',
        '\\busages?\\s+of\\b',
        '\\bwhat\\s+type\\b',
        '\\bimplementations?\\s+of\\b',
        '\\bsubclasses\\s+of\\b',
        '\\b(?:find|locate)\\s+(?:the\\s+)?(?:class|interface|method|function|component|service|enum|record|struct)\\s+`?[A-Za-z_]',
    ].join('|'),
    'i',
);

function main()
{
    const task = String(payload.task || '');

    // explore is read-only by construction - it can never be the implementer fan-out - but it is
    // grep-shaped, so a symbol question goes back to serena instead.
    if (payload.subagent_type === 'explore')
    {
        const asked = task.match(SYMBOL_QUESTION);
        if (asked)
        {
            deny(
                `Blocked an explore dispatch for a symbol question ('${asked[0].trim()}') - answer it inline with serena.`,
                `Blocked: dispatch of explore for a SYMBOL question ('${asked[0].trim()}'). A grep-shaped seat answers that by `
                + 'name-match, and name-matches lie. Answer it INLINE instead: serena find_symbol for a declaration or signature, '
                + 'find_referencing_symbols for callers, get_symbols_overview (ONE file, depth 2 on C#) to enumerate - falling back '
                + 'to the language server when serena cannot resolve it. Dispatch a search seat only for a genuinely broad '
                + 'multi-file sweep that asks no symbol question.',
            );
        }
        allow();
    }

    const seatMatch = task.match(/\b([a-z][a-z0-9-]*-implementer)\b/);
    if (!seatMatch)
    {
        allow();
    }

    const seat = seatMatch[1];
    const root = (payload.workspace_roots || [])[0] || process.cwd();
    const gate = path.resolve(root, docsRootEnv(), 'flow', 'APPROVAL');

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
        // birthtime is real only where the filesystem reports it - Node documents that elsewhere the
        // field falls back to the ctime (or the epoch). A transcript's ctime is its LAST write, which
        // would date every stamp before the session and block every dispatch with a false 'stale';
        // a birthtime equal to the ctime is that fallback and counts as unknown (the age cap still holds).
        let sessionStartMs = 0;
        try
        {
            const st = fs.statSync(String(payload.transcript_path || payload.conversation_path || ''));
            sessionStartMs = st.birthtimeMs && st.birthtimeMs !== st.ctimeMs ? st.birthtimeMs : 0;
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
        ? `the approval stamp at ${gate} is stale: older than 8h, or written before this session began, so it records another run's decision rather than this one's (measured: a 2h52m-old stamp from a closed session authorized five implementer dispatches).`
        : 'no approval gate is recorded.';

    deny(
        `Blocked a dispatch of ${seat} that has no recorded approval.`,
        `Blocked: dispatch of ${seat} - ${why} `
            + 'Implementer fan-out runs only on the user\'s explicit approval, or their explicit \'run without stops\' waiver - never on an '
            + `inferred or ambiguous go-ahead. If the user gave one THIS conversation, write ${gate} with one first line - `
            + 'APPROVED <plan/contract id> - "<their words, verbatim>" (or AUTO - "<their words, verbatim>" for a no-stops run) - then retry '
            + 'the dispatch. Never fabricate the quote. Otherwise: present the plan and ask the user - that stop IS the recovery path. Do NOT '
            + 'route around this gate by doing the seat\'s build work inline instead: a blocked dispatch means the flow is missing its approval, '
            + 'not that the flow should be abandoned (measured: one session answered this block by building inline and shipped the runtime '
            + 'defect the gated flow\'s verify step exists to catch). Clear the file when the run completes.',
    );
}

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () =>
{
    try
    {
        payload = JSON.parse(input);
    }
    catch
    {
        allow(); // can't parse hook input -> don't block on a harness malfunction
    }
    if (!payload || typeof payload !== 'object')
    {
        allow(); // a JSON scalar/null - nothing to judge
    }
    main();
});
