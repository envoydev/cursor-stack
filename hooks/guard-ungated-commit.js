#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// beforeShellExecution gate: the pre-commit checkpoint, mechanized.
//
// A non-trivial `git commit` runs only after the house review gate (project-verify-code,
// plus /review on auth/crypto/data-access paths) or the user's explicit waiver, recorded
// as a receipt file the gate step writes. Prose measured unreliable on the peer stack: 8
// ungated commit events across 6 audited sessions, including one where the git baseline
// was provably in context the same session and skipped anyway, and one commit with no
// user authorization at all. Trivial diffs pass untouched (the rule's own typo/one-line
// exemption, judged from the working-tree diff).
//
// Receipt lifecycle: the gate step writes <docs-root>/flow/COMMIT-GATE when its checks
// pass (VERIFIED <scope>) or the user explicitly waives (WAIVED - "<their words>"); the
// commit turn clears it after the commit lands. Receipts older than MAX_RECEIPT_AGE_MS
// are treated as absent - a leftover stamp silently authorized later, unrelated runs.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MAX_RECEIPT_AGE_MS = 2 * 60 * 60 * 1000; // 2h - the gate runs right before the commit; re-stamping is one write

const allow = () => respond({ permission: 'allow' });

function respond(body)
{
    process.stdout.write(JSON.stringify(body));
    process.exit(0);
}

function deny(userMessage, agentMessage)
{
    respond({ permission: 'deny', user_message: userMessage, agent_message: agentMessage });
}

const unquote = s => s.replace(/^["']|["']$/g, '');

function main(payload)
{
    const command = String(payload.command || '');
    // A real `git commit` subcommand (allowing -C/-c/global flags between), not `git log --grep commit`.
    const commitMatch = command.match(/\bgit(\s+-[cC]?\s*\S+|\s+--\S+)*\s+commit\b/);
    if (!commitMatch)
    {
        allow();
    }

    // An atomic write-receipt-then-commit command carries its own receipt: the gate file is
    // written (with a VERIFIED/WAIVED line in the same command text) before git runs. Blocking
    // it would reject the receipt discipline this gate exists to enforce. All matches are bound
    // to the PRE-commit segment - a commit message merely mentioning COMMIT-GATE is not a receipt.
    const preCommit = command.slice(0, commitMatch.index);
    if (preCommit.includes('COMMIT-GATE')
        && /(>>?|\btee\b|\bcat\b|\bprintf\b)/.test(preCommit)
        && (/\bWAIVED\b/.test(preCommit)
            || (/\bVERIFIED\b/.test(preCommit) && /authorized:/.test(preCommit))))
    {
        allow();
    }

    // Resolve the repo the commit actually runs in: a `cd <sibling> && git commit` or a
    // `git -C <sibling> commit` executes in a DIFFERENT repo than this hook's default root,
    // so the diff and receipt checks below would otherwise judge the wrong tree.
    let root = payload.cwd || (payload.workspace_roots || [])[0] || process.cwd();
    const cdMatches = [...preCommit.matchAll(/(?:^|&&|;|\n|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)];
    if (cdMatches.length)
    {
        root = path.resolve(root, unquote(cdMatches[cdMatches.length - 1][1]));
    }

    const dashC = commitMatch[0].match(/\s-C\s*("[^"]+"|'[^']+'|\S+)/);
    if (dashC)
    {
        root = path.resolve(root, unquote(dashC[1]));
    }

    // Trivial-diff exemption: total churn across the uncommitted tree (staged + unstaged - a
    // chained `git add && git commit` stages mid-command, so staged-only would undercount).
    // <= 2 files and <= 15 changed lines is the typo/one-line class; anything bigger gates.
    try
    {
        const numstat = execSync('git diff HEAD --numstat', { cwd: root, timeout: 5000 }).toString().trim();
        if (!numstat)
        {
            allow(); // nothing to commit - let git say so
        }

        const rows = numstat.split('\n');
        const lines = rows.reduce((n, r) =>
        {
            const [added, deleted] = r.split('\t');
            return n + (parseInt(added, 10) || 0) + (parseInt(deleted, 10) || 0);
        }, 0);
        if (rows.length <= 2 && lines <= 15)
        {
            allow();
        }
    }
    catch
    {
        allow(); // not a git repo / git unavailable - never block on our own failure
    }

    const docsRoot = process.env.CURSOR_DOCS_PATH || '.cursor/docs';
    const gate = path.join(root, docsRoot, 'flow', 'COMMIT-GATE');
    let first = '';
    let second = '';
    let stale = false;
    try
    {
        const age = Date.now() - fs.statSync(gate).mtimeMs;
        if (age > MAX_RECEIPT_AGE_MS)
        {
            stale = true;
        }
        else
        {
            const lines = fs.readFileSync(gate, 'utf8').split('\n');
            first = (lines[0] || '').trim();
            second = (lines[1] || '').trim();
        }
    }
    catch
    {
        // absent or unreadable - no gate receipt
    }

    // WAIVED carries the user's words on its own line; VERIFIED needs the authorized: second
    // line - a review receipt alone is not consent.
    if (/^WAIVED\b/.test(first))
    {
        allow();
    }

    // The authorized: line must carry the user's actual quoted words - the label alone is not
    // consent, and a two-stage receipt's 'authorized: PENDING' draft matches the bare prefix.
    const authReal = /^authorized:/.test(second) && /["'“‘]/.test(second) && !/\bPENDING\b/i.test(second);
    const noAuth = /^VERIFIED\b/.test(first) && !authReal;
    if (/^VERIFIED\b/.test(first) && !noAuth)
    {
        allow();
    }

    const why = stale
        ? `the gate receipt at ${gate} is older than 2h and is treated as absent (a stale receipt from an earlier round is not this diff's review).`
        : noAuth
            ? `the gate receipt at ${gate} has a VERIFIED first line but its 'authorized:' second line is missing, a PENDING placeholder, or carries no quoted words; the review ran, but nothing records the user asking for THIS commit.`
            : 'there is no pre-commit gate receipt for this non-trivial diff.';

    deny(
        'Blocked a non-trivial git commit that has not been through the pre-commit review gate.',
        `Blocked: git commit - ${why} `
        + 'The checkpoint (baseline-git.mdc) runs BEFORE a non-trivial commit: the formatter, then the house review '
        + 'project-verify-code - plus /review when the diff touches auth/crypto/secrets/payment/data-access paths '
        + `(baseline-security.mdc). When those pass, write ${gate} with one first line - VERIFIED <what was reviewed, one phrase> - `
        + 'and a second line authorized: "<the user\'s words asking for THIS commit, verbatim>". A receipt proves the review ran; '
        + 'the authorized line proves the user asked for the commit. Then retry. If the user EXPLICITLY waived the gate this '
        + 'conversation, write WAIVED - "<their words, verbatim>" instead; never fabricate either quote, and \'commit it\' alone is an '
        + 'instruction to commit, not a waiver of the review. Do not split a real change into tiny commits to slip under the '
        + 'trivial-diff exemption. Clear the file once the commit lands.',
    );
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
