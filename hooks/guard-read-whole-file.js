#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
//
// Wired to TWO events, and it branches on hook_event_name:
//   beforeReadFile        - the file is about to enter the model's context.
//   beforeShellExecution  - the same dump routed around the read tool (`cat file.ts`).
//
// It enforces baseline-navigation.mdc's hard rule: reading a file is for code you have
// ALREADY located, never for finding a symbol. A whole-file read of a large source file
// is blocked so navigation goes through serena (get_symbols_overview -> find_symbol)
// first. Measured on the peer stack: one session dumped, via the shell, the exact file
// the read gate had just blocked, and a 47-file grep loop pushed ~19.8k tokens past a
// gate that only watched the read tool - so both doors are covered here.
//
// beforeReadFile hands over the content itself, so this measures what is actually about
// to be delivered rather than inferring it from range arguments. It also caps CUMULATIVE
// delivery per file per conversation: two or three half-reads that reconstruct a whole
// file each pass a per-call check, so past ~60% coverage the remainder goes through serena.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Symbol-navigable sources plus the large templates you should read by range. SQL, SCSS
// and markdown are not symbol-navigable, so they are not gated.
const GATED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|cs|go|razor|cshtml|xaml|html)$/;

// 200, not 100: on the peer stack, ~71% of blocks landed on 100-200 line files where the
// forced detour costs about what the whole-file read would. The gate only pays above 200.
const THRESHOLD = 200;
const COVERAGE_CAP = 0.6;

// A heredoc body is DATA, not shell: a plan or checklist that merely DESCRIBES a dump is inert
// text, and matching it blocked a document write for its own prose (measured). Blank the payload
// spans, keeping the character count so any index into the command still holds.
const stripHeredocs = (c) => String(c).replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    (m) => m.replace(/[^\n]/g, ' '),
);

// Same extensions as GATED_EXT, unanchored - a sweep names its files inside a glob or a loop body,
// never as the command string's own tail.
const GATED_EXT_ANY = /\.(ts|tsx|js|jsx|mjs|cjs|cs|go|razor|cshtml|xaml|html)\b/i;

const allow = () => respond({ permission: 'allow' });
const deny = (userMessage, agentMessage) => respond({ permission: 'deny', user_message: userMessage, agent_message: agentMessage });

function respond(body)
{
    process.stdout.write(JSON.stringify(body));
    process.exit(0);
}

function serenaHint(file)
{
    return `Locate first with serena: get_symbols_overview('${file}') then find_symbol(...), `
        + 'then read only the returned range (find_symbol with include_body=true only for a SMALL '
        + 'symbol; for a large body fetch it without the body first, then read the range you need).';
}

function countLines(text)
{
    return text ? text.split('\n').length : 0;
}

function fileLineCount(file)
{
    try
    {
        return countLines(fs.readFileSync(file, 'utf8'));
    }
    catch
    {
        return 0;
    }
}

// Per-conversation coverage ledger. Best-effort: a lost ledger only means the cumulative
// cap restarts, never that a per-call block is skipped.
function bumpCoverage(conversationId, file, delivered)
{
    const key = String(conversationId || 'noconversation').replace(/[^\w-]/g, '');
    const stateFile = path.join(os.tmpdir(), `cursor-guard-read-${key}.json`);
    let state = {};
    try
    {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
    catch
    {
        // fresh ledger
    }

    const total = (state[file] || 0) + delivered;
    state[file] = total;
    try
    {
        fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    catch
    {
        // the ledger is best-effort
    }

    return total;
}

// ---- beforeShellExecution: a whole-file dump through the shell ----
function handleShell(payload)
{
    const command = stripHeredocs(payload.command || '');
    // Only cat/sed were gated, so the same dump walked through under any other verb: head -n
    // <huge>, tail -n +1, less, awk '1', a runtime open().read() (measured x5 against a real file).
    if (!/\bcat\b|\bsed\b|\bhead\b|\btail\b|\bless\b|\bmore\b|\bawk\b|\bopen\(/.test(command))
    {
        allow();
    }

    // Three shapes dumped whole trees past the per-file check below - a loop whose cat argument is
    // the loop VARIABLE, a find -exec whose argument is the literal {}, and an xargs cat. None can
    // be size-checked per file, and all three are the sweep this gate exists to stop.
    const sweep = /\bfor\s+\w+\s+in\b[^\n]*\bdo\b[^\n]*\bcat\b/i.test(command)
        ? 'a shell loop over a file list'
        : /\bfind\b[^\n]*-exec\s+cat\b/i.test(command)
            ? 'find -exec cat'
            : /\|\s*xargs\s+(?:-\w+\s+)*cat\b/i.test(command)
                ? 'xargs cat'
                : null;
    if (sweep && GATED_EXT_ANY.test(command))
    {
        deny(
            `Blocked a whole-file sweep of source files through ${sweep}.`,
            `Blocked: whole-file sweep of source files via ${sweep}. Every file in the sweep is dumped unchecked - the `
            + `per-file size gate cannot see a loop variable or a find placeholder. Per baseline-navigation.mdc, locate what `
            + `you need first (serena find_symbol / get_symbols_overview, or grep -n), then read only the ranges that matter.`
        );
    }

    const runtimeDump = /\b(python3?|node|perl|ruby)\b[^\n]*\b(open\([^)]*\)\s*\.read\(|readFileSync|File\.read)/.test(command);
    const unbounded = /\bhead\s+-n\s*(\d{5,})\b/.test(command) || /\btail\s+-n\s*\+\s*1\b/.test(command)
        || /\b(less|more)\s+\S/.test(command) || /\bawk\s+(['"])1\1\s+\S/.test(command);
    if ((runtimeDump || unbounded) && GATED_EXT_ANY.test(command))
    {
        deny(
            'Blocked an unbounded whole-file dump of a source file through the shell.',
            'Blocked: unbounded whole-file dump (head -n <huge> / tail -n +1 / less / awk \'1\' / a runtime open().read()). '
            + 'Per baseline-navigation.mdc, read the located range - serena find_symbol, or a bounded sed -n \'<start>,<end>p\'.'
        );
    }

    const anchors = [payload.cwd, ...(payload.workspace_roots || []), process.cwd()].filter(Boolean);
    const resolve = (file) =>
    {
        if (path.isAbsolute(file)) return { lines: fileLineCount(file), resolved: true };
        for (const dir of anchors)
        {
            const abs = path.join(dir, file);
            if (fs.existsSync(abs)) return { lines: fileLineCount(abs), resolved: true };
        }

        return { lines: 0, resolved: false };
    };

    // Per pipeline segment: a bare `cat <gated file>` with no limiting filter after it is a
    // whole-file dump; piping into head/grep/wc is targeted.
    for (const segment of command.split(/&&|\|\||;|\n/))
    {
        if (/\|\s*(head|tail|sed|grep|rg|wc|awk|cut)\b/.test(segment))
        {
            continue;
        }

        // `cat a.cs b.cs` size-checked only the first argument (measured) - take every path token.
        const catAll = segment.match(/\bcat\s+((?:(?:-\w+|"[^"]+"|'[^']+'|[^\s;&|<>]+)\s*)+)/);
        const files = catAll
            ? catAll[1].trim().split(/\s+/).filter((t) => !t.startsWith('-')).map((t) => t.replace(/^["']|["']$/g, ''))
            : [];
        const sedMatch = segment.match(/\bsed\s+-n\s+["']1,\$p["']\s+("[^"]+"|'[^']+'|[^\s;&|<>]+)/);
        if (sedMatch) files.push(sedMatch[1].replace(/^["']|["']$/g, ''));
        for (const file of files)
        {
        if (!GATED_EXT.test(file))
        {
            continue;
        }

        const { lines, resolved } = resolve(file);
        if (!resolved)
        {
            // A dump-shaped command on a gated file whose size cannot be checked fails CLOSED -
            // an unresolvable relative path was exactly how whole-file dumps slipped past.
            deny(
                `Blocked a whole-file dump of ${file}: its size could not be checked.`,
                `Blocked: cannot size ${file} (the relative path did not resolve against the shell cwd or a workspace root). `
                + `A whole-file cat/sed of a source file must be size-checked - re-run with an absolute path, or locate the symbol first. ${serenaHint(file)}`,
            );
        }

        if (lines > THRESHOLD)
        {
            deny(
                `Blocked a whole-file dump of ${file} (${lines} lines) through the shell.`,
                `Blocked: whole-file dump of ${file} (${lines} lines) via the shell. Per baseline-navigation.mdc, a bare cat/sed of a large `
                + `source file is the same whole-file read the read gate blocks, routed through the terminal. ${serenaHint(file)}`,
            );
        }
        }
    }

    allow();
}

// ---- beforeReadFile: the content is about to be delivered ----
function handleRead(payload)
{
    const file = String(payload.file_path || '');
    if (!GATED_EXT.test(file))
    {
        allow();
    }

    const delivered = countLines(payload.content || '');
    if (delivered === 0)
    {
        allow(); // nothing being handed over - let the read surface its own error
    }

    const total = fileLineCount(file) || delivered;
    if (total <= THRESHOLD)
    {
        allow(); // small files are cheap to read whole
    }

    if (delivered > THRESHOLD)
    {
        deny(
            `Blocked a whole-file read of ${path.basename(file)} (${delivered} of ${total} lines).`,
            `Blocked: whole-file read of ${file} - ${delivered} lines of a ${total}-line file. Per baseline-navigation.mdc, reading a file is `
            + `for code you have ALREADY located, never for finding a symbol. Read half the file or less per range. ${serenaHint(file)}`,
        );
    }

    const covered = bumpCoverage(payload.conversation_id, file, delivered);
    if (covered > total * COVERAGE_CAP)
    {
        deny(
            `Blocked: ranged reads of ${path.basename(file)} now cover ${Math.round((100 * covered) / total)}% of it this conversation.`,
            `Blocked: ranged reads of ${file} now cover ${Math.round((100 * covered) / total)}% of its ${total} lines this conversation - `
            + `reconstructing a large file from half-reads is the whole-file read this gate exists to stop. For the remainder: ${serenaHint(file)}`,
        );
    }

    allow();
}

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () =>
{
    let payload;
    try
    {
        payload = JSON.parse(input);
    }
    catch
    {
        allow(); // can't parse hook input -> don't block on a harness malfunction
    }

    if (payload.hook_event_name === 'beforeShellExecution' || payload.command !== undefined) handleShell(payload);
    else handleRead(payload);
});
