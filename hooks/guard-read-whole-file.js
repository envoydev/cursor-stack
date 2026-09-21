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
// A whole read of any OVERSIZED file (past 60KB) is blocked whatever its extension, and a sweep
// over `.md` files counts as a sweep. On the shell route a target this hook cannot see through - an
// unexpanded `$VAR` - is judged by nobody rather than denied, a leading `cd` moves its anchor, and a
// runtime expression that only COUNTS is not a dump. Every block appends one ledger row.
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
// The SWEEP branch adds `md`. A loop over every SKILL.md in an install is the single most measured
// dump shape on the peer stack - 84.1KB from 35 files in one call, 120KB from 46 in another, and the
// only thing that stopped either was the harness's own output cap. Markdown is not symbol-navigable,
// so the single-file size check deliberately still ignores it: one named `.md` file is a fine read,
// thirty-five of them in a loop is not.
const SWEEP_EXT_ANY = /\.(ts|tsx|js|jsx|mjs|cjs|cs|go|razor|cshtml|xaml|html|md)\b/i;
// A file too big to fit a tool result is the most predictable whole-read in the system, whatever its
// extension - see handleRead.
const BIG_BYTES = 60 * 1024;

// `$VAR` / `${VAR}` that this hook cannot see through: judging a path whose value is unknown is
// guessing, not gating (6 of 12 measured denials in one peer-stack project named a `$R/...` target).
const isVar = (s) => /\$\{?[A-Za-z_]/.test(s);
// A `VAR=value` set in the SAME command is knowable - expand those before giving up on a target.
const assignsOf = (cmd) =>
{
    const m = new Map();
    for (const a of String(cmd).matchAll(/(?:^|&&|\|\||;|\n|\s)([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g))
        m.set(a[1], a[2].replace(/^["']|["']$/g, ''));
    return m;
};
const expandWith = (assigns, s) => String(s).replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (m, br, bare) => (assigns.has(br || bare) ? assigns.get(br || bare) : m));
// A `cd <dir> &&` at the head of the command moves the anchor for everything after it, and a relative
// target then resolves nowhere - which failed CLOSED and denied the call. Every literal `cd` target is
// one more candidate anchor; a variable or `-` target is unfollowable and contributes nothing.
const CD_RE = /(?:^|&&|\|\||;|\n|\(|\|)\s*(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;|&()]+)/g;
// Git Bash / MSYS spell a Windows path in POSIX MOUNT form (`/c/Users/...`, `/cygdrive/c/...`),
// which node on win32 resolves against the CURRENT drive instead - a falsehood that made the
// peer stack's guards judge a path that was never the one named. Translate before resolving;
// off Windows the spelling is a real POSIX path and is never touched.
const MOUNT_RE = /^(?:\/cygdrive)?\/([A-Za-z])(?=\/|$)/;
const nativePath = (p) => (process.platform === 'win32'
    ? String(p).replace(MOUNT_RE, (m, d) => `${d.toUpperCase()}:\\`)
    : String(p));

// The docs root env value - where the block ledger below is written.
const docsRootEnv = () => process.env.CURSOR_DOCS_PATH || '.cursor/docs';
let payload = {};
let currentEvent = '';

const allow = () => respond({ permission: 'allow' });

function respond(body)
{
    process.stdout.write(JSON.stringify(body));
    process.exit(0);
}

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
        const root = payload.cwd || (payload.workspace_roots || [])[0] || process.cwd();
        // resolve, NOT join: an ABSOLUTE CURSOR_DOCS_PATH makes path.join('/a/b','/x/y') into
        // '/a/b/x/y', so every ledger row lands in a doubled path that nothing reads. resolve
        // honours an absolute value and still joins a relative one.
        const dir = path.resolve(root, docsRootEnv(), 'hook-blocks');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${payload.session_id || 'nosession'}.jsonl`), JSON.stringify({
            ts: new Date().toISOString(),
            hook: path.basename(__filename),
            event,
            tool: event === 'beforeReadFile' ? 'read' : 'shell',
            reason: String(reason).split('\n')[0].slice(0, 200),
        }) + '\n');
    }
    catch { /* telemetry is never allowed to break the gate */ }
}

function deny(userMessage, agentMessage)
{
    ledger(currentEvent, agentMessage);
    respond({ permission: 'deny', user_message: userMessage, agent_message: agentMessage });
}

// The three trees the installers seed into serena's OWN `ignored_paths` (.serena/project.yml):
// serena cannot index them, so naming its tools for a path under one of them hands the model a
// remedy that errors. Measured twice - the denial named serena for a `.cursor/...` path and the
// redirect the model made from it failed. The ranged read is the remedy there.
const SERENA_IGNORED = /(?:^|[\\/])\.(?:cursor|serena|playwright)(?:[\\/]|$)/;

function serenaHint(file)
{
    if (SERENA_IGNORED.test(String(file)))
    {
        return 'serena cannot locate anything here: the installers seed `.cursor` / `.serena` / `.playwright` '
            + 'into its own ignored_paths, so this tree is not indexed. Locate inside the file instead: '
            + `grep -n '<pattern>' '${file}', then read only the lines it names.`;
    }
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

// Per-conversation coverage ledger: merge this delivery's line range into the file's interval set
// and return the merged coverage. Merged, not summed - re-reading the same range after an edit is
// one range, and summing it twice blocked a read that reconstructed nothing. beforeReadFile hands
// over content, not offset/limit, so the range is located by finding the content in the file; a
// delivery that cannot be located (transformed, or the file changed) is summed, which is the old
// behaviour for that call only. Best-effort: a lost ledger
// only means the cumulative cap restarts, never that a per-call block is skipped.
function coverageOf(conversationId, file, content, delivered)
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

    // { spans: [[start, end], ...], unlocated: <lines> } - an older numeric entry restarts the file.
    const entry = state[file] && Array.isArray(state[file].spans) ? state[file] : { spans: [], unlocated: 0 };
    let start = 0;
    try
    {
        const text = fs.readFileSync(file, 'utf8');
        const idx = content ? text.indexOf(content) : -1;
        if (idx >= 0) start = countLines(text.slice(0, idx)) || 1;
    }
    catch
    {
        // unreadable - counted as an unlocated delivery below
    }
    if (start > 0) entry.spans.push([start, start + delivered - 1]);
    else entry.unlocated += delivered;
    const merged = [];
    for (const iv of entry.spans.sort((a, b) => a[0] - b[0]))
    {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
    }
    // Saved only when the read is ALLOWED: a blocked delivery never reached the context, so it must
    // not count toward the next read's coverage.
    const save = () =>
    {
        state[file] = { spans: merged, unlocated: entry.unlocated };
        try
        {
            fs.writeFileSync(stateFile, JSON.stringify(state));
        }
        catch
        {
            // the ledger is best-effort
        }
    };

    return { covered: merged.reduce((n, [a, b]) => n + (b - a + 1), 0) + entry.unlocated, save };
}

// ---- beforeShellExecution: a whole-file dump through the shell ----
function handleShell()
{
    const command = stripHeredocs(payload.command || '');
    // This pre-filter must name every verb the branches below look for: `readFileSync` / `File.read`
    // were in the runtime-dump pattern but not here, so `node -e "...readFileSync(f)..."` exited on
    // this line and that branch never ran (reproduced on the peer stack against a 1371-line file).
    if (!/\bcat\b|\bsed\b|\bhead\b|\btail\b|\bless\b|\bmore\b|\bawk\b|\bopen\(|\breadFileSync\b|File\.read/.test(command))
    {
        allow();
    }

    const anchors = [payload.cwd, ...(payload.workspace_roots || []), process.env.CURSOR_PROJECT_DIR, process.cwd()].filter(Boolean);
    // Anchors and same-command assignments, computed once for every check below.
    const assigns = assignsOf(command);
    for (const c of command.matchAll(CD_RE))
    {
        const target = expandWith(assigns, c[1].replace(/^["']|["']$/g, ''));
        if (target === '-' || isVar(target)) continue;
        const abs = path.isAbsolute(nativePath(target)) ? nativePath(target) : path.join(anchors[0] || process.cwd(), target);
        if (!anchors.includes(abs)) anchors.push(abs);
    }
    const resolve = (raw) =>
    {
        const file = nativePath(raw);
        if (path.isAbsolute(file)) return { lines: fileLineCount(file), resolved: true };
        for (const dir of anchors)
        {
            const abs = path.join(dir, file);
            if (fs.existsSync(abs)) return { lines: fileLineCount(abs), resolved: true };
        }

        return { lines: 0, resolved: false };
    };

    // EVERY test below is PER SEGMENT, and the extension is tested against the PATH the verb names -
    // never against the whole command. Testing the extension against the whole compound command
    // denied a command for an unrelated `*.js` glob sitting in a SIBLING segment, and the sweep test
    // denied an exact-filename `find -name` because a co-located bounded `grep | head -20` shared the
    // line (both replayed on the peer stack).
    const gatedIn = (text) => GATED_EXT_ANY.test(text);

    // Three shapes dump whole trees past the per-file check below - a loop whose cat argument is the
    // loop VARIABLE, a find -exec whose argument is the literal {}, and an xargs cat. None can be
    // size-checked per file. A loop SPANS `;` boundaries by nature, so this one test stays above the
    // segment loop - but the extension is tested against the CONSTRUCT's own text. A `find -name
    // '<literal filename>'` is exempt: no glob metacharacter means it names ONE file - the 'I know the
    // name, not the path' idiom - EXCEPT for markdown, where `-name SKILL.md` names one file per skill
    // directory (35 of them in the measured dump, 46 in the next): that is the sweep, not the idiom.
    // The loop's own text ENDS at `done`: `[^\n]*?` ran straight past it, so an unrelated `cat` in a
    // later statement was read as the loop's body. Measured twice at ~88k tokens a block - the
    // capabilities skill's own grep-only loop followed by `; cat .mcp.json` was denied as a sweep.
    const NOT_DONE = '(?:(?!\\bdone\\b)[^\\n])';
    const sweepM = command.match(new RegExp(`\\bfor\\s+\\w+\\s+in\\b${NOT_DONE}*?\\bdo\\b${NOT_DONE}*?\\bcat\\b${NOT_DONE}*`, 'i'))
        || command.match(/\bfind\b[^\n]*?-exec\s+cat\b[^\n]*/i)
        || command.match(/[^\n]*?\|\s*xargs\s+(?:-\w+\s+)*cat\b[^\n]*/i);
    if (sweepM)
    {
        const sweep = /\bfor\b/i.test(sweepM[0]) ? 'a shell loop over a file list'
            : /-exec/i.test(sweepM[0]) ? 'find -exec cat' : 'xargs cat';
        const namedFind = sweepM[0].match(/-name\s+(["']?)([^"'\s*?\[\]]+)\1(?=\s|$)/);
        const namedOne = namedFind && !/\.md\b/i.test(namedFind[2] || '');
        if (!namedOne && SWEEP_EXT_ANY.test(sweepM[0]))
        {
            deny(
                `Blocked a whole-file sweep of source files through ${sweep}.`,
                `Blocked: whole-file sweep of source files via ${sweep}. Every file in the sweep is dumped unchecked - the `
                + `per-file size gate cannot see a loop variable or a find placeholder. Per baseline-navigation.mdc, locate what `
                + `you need first (serena find_symbol / get_symbols_overview, or grep -n), then read only the ranges that matter. `
                + `If you genuinely need one whole small file, cat it by name.`,
            );
        }
    }

    for (const segment of command.split(/&&|\|\||;|\n/))
    {
        // Piping into head/grep/wc is targeted.
        if (/\|\s*(head|tail|sed|grep|rg|wc|awk|cut)\b/.test(segment))
        {
            continue;
        }
        // Output redirected INTO a file never reaches the context - `cat a.ts > copy.ts` is a copy,
        // not a dump (an fd form like `2>&1` / `>&2` still prints, so only a path target is exempt).
        if (/\s>>?\s*[^&\s>]/.test(segment))
        {
            continue;
        }

        // A whole-file read through a language runtime is the same dump with a different spelling.
        const rtCall = segment.match(/\b(?:python3?|node|perl|ruby)\b[^\n]*?\b(?:open\(\s*(["'][^"']*["'])[^)]*\)\s*\.read\(|(?:readFileSync|File\.read)\(\s*(["'][^"']*["']))/);
        if (rtCall && gatedIn(rtCall[1] || rtCall[2] || segment))
        {
            // This branch used to block on the extension ALONE, and it could not tell a dump from a
            // COUNT (measured on the peer stack: a `node -e` whose entire output was `.match(...).length`
            // on a 198-line file was denied, costing a 107k-token retry). Two exemptions, in order:
            //   - the expression REDUCES: the read feeds a count/search/test and the content itself is
            //     never printed, so nothing large can reach the context;
            //   - the file is knowable and under THRESHOLD, exactly as for `cat`.
            const lit = String(rtCall[1] || rtCall[2] || '').replace(/^["']|["']$/g, '');
            const reduces = /\)\s*\.\s*(?:match|split|indexOf|lastIndexOf|includes|search|test|length|filter|reduce|count|find|index|scan)\b/.test(segment)
                && !/\bconsole\.log\(\s*(?:[A-Za-z_$][\w$]*\s*\)|(?:fs\.)?readFileSync|open\()/.test(segment)
                && !/\bprint\(\s*open\(/.test(segment);
            let oversized = true;
            if (lit && !isVar(lit))
            {
                const { lines, resolved } = resolve(expandWith(assigns, lit));
                if (resolved) oversized = lines > THRESHOLD;
            }
            if (!reduces && oversized)
            {
                deny(
                    'Blocked a whole-file read of a source file through a language runtime.',
                    'Blocked: whole-file read of a source file through a language runtime. Per baseline-navigation.mdc this is the '
                    + 'same whole-file read the read gate blocks, spelled differently. Locate the symbol first (serena find_symbol / '
                    + 'get_symbols_overview), then read only the range you need. An expression that only COUNTS or SEARCHES - the '
                    + 'read feeding .match/.split/.length with no print of the content - is not a dump and is not blocked.',
                );
            }
        }

        // A dump verb whose output is unbounded is a dump: `head -n <huge>` and `tail -n +1` both print
        // the whole file, while a bounded `head -40` is the targeted read this gate exists to encourage.
        const unbounded = segment.match(/\bhead\s+-n\s*\d{5,}\s+((?:-\S+\s+)*\S+)/)
            || segment.match(/\btail\s+-n\s*\+\s*1\s+((?:-\S+\s+)*\S+)/)
            || segment.match(/\b(?:less|more)\s+((?:-\S+\s+)*\S+)/)
            || segment.match(/\bawk\s+(?:['"])1(?:['"])\s+((?:-\S+\s+)*\S+)/);
        if (unbounded && gatedIn(unbounded[1]))
        {
            deny(
                'Blocked an unbounded whole-file dump of a source file through the shell.',
                'Blocked: unbounded whole-file dump (head -n <huge> / tail -n +1 / less / awk \'1\'). '
                + 'Per baseline-navigation.mdc, read the located range - serena find_symbol, or a bounded sed -n \'<start>,<end>p\'.',
            );
        }

        // A bare `cat <gated file>` (or sed -n '1,$p') with no limiting filter after it is a whole-file
        // dump. `cat a.cs b.cs` size-checked only the first argument (measured) - take every path token.
        const catAll = segment.match(/\bcat\s+((?:(?:-\w+|"[^"]+"|'[^']+'|[^\s;&|<>]+)\s*)+)/);
        const files = catAll
            ? catAll[1].trim().split(/\s+/).filter((t) => !t.startsWith('-')).map((t) => t.replace(/^["']|["']$/g, ''))
            : [];
        const sedMatch = segment.match(/\bsed\s+-n\s+["']1,\$p["']\s+("[^"]+"|'[^']+'|[^\s;&|<>]+)/);
        if (sedMatch) files.push(sedMatch[1].replace(/^["']|["']$/g, ''));
        for (const rawFile of files)
        {
            const file = expandWith(assigns, rawFile);
            if (!GATED_EXT.test(file))
            {
                continue;
            }
            // A target still carrying an unexpanded variable is unknowable: judge nothing rather than
            // deny on a guess. This failed CLOSED before, and half the denials in one measured peer-stack
            // project were `$R/...` paths the session had every right to read.
            if (isVar(file))
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
                    `Blocked: cannot size ${file} (the relative path did not resolve against the shell cwd, a cd target or a workspace root). `
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
function handleRead()
{
    const file = String(payload.file_path || '');
    const delivered = countLines(payload.content || '');
    if (!GATED_EXT.test(file))
    {
        // A file too big to fit a tool result is the most predictable whole-read in the system,
        // whatever its extension: an oversized output spilled to disk is read straight back into
        // context. Measured on the peer stack: a 93KB spill read WHOLE, twice, for 99,277 chars and no
        // block, because the extension was not on the gated list. This branch judges SIZE, not
        // language, and only ever objects to the whole-file SHAPE - here, content that delivers the
        // file's every line. A ranged read of the same file passes untouched, which is the remedy.
        let size = 0;
        try
        {
            size = fs.statSync(file).size;
        }
        catch
        {
            // missing - let the read surface its own error
        }
        // Line counting reads the file, so it runs only past the size bar.
        if (size > BIG_BYTES && delivered > 0 && delivered >= fileLineCount(file))
        {
            // A grep remedy needs LINES. This branch judges size, not language, so it also catches the
            // 93KB PNG and the one-line minified bundle, where `grep -n` and a ranged read both answer
            // nothing (measured: 2 wasted calls on an image). Sniff the first bytes and prescribe PAGING.
            let head = null;
            try
            {
                const fd = fs.openSync(file, 'r');
                const buf = Buffer.alloc(4096);
                const n = fs.readSync(fd, buf, 0, 4096, 0);
                fs.closeSync(fd);
                head = buf.subarray(0, n);
            }
            catch
            {
                // unreadable - fall back to the line-based remedy
            }
            const unlined = !!head && (head.includes(0) || head.toString('latin1').split('\n').some((l) => l.length > 1000));
            deny(
                `Blocked a whole-file read of ${path.basename(file)} (${Math.round(size / 1024)}KB).`,
                `Blocked: whole-file read of ${file} (${Math.round(size / 1024)}KB). A file this large does not fit a tool result - `
                + 'reading it whole spends its entire size on context, and every message after it re-sends that. '
                + (unlined
                    ? 'This file is binary or minified - it has no lines to grep or to read by range. Page it: '
                      + `head -c 2000 '${file}', or sed -n '1,40p' '${file}' if it has lines at all, or file '${file}' when the bytes say nothing.`
                    : `Take what you came for instead: grep -n '<pattern>' '${file}', then read only the lines it names. `
                      + 'A persisted or spilled output is the common case here: grep or tail it, never read it whole.'),
            );
        }
        allow();
    }

    if (delivered === 0)
    {
        allow(); // nothing being handed over - let the read surface its own error
    }

    const total = fileLineCount(file) || delivered;
    if (total <= THRESHOLD)
    {
        allow(); // small files are cheap to read whole
    }

    // The whole-file SHAPE: content that covers every line of the file. A window genuinely smaller
    // than the file is targeted, and the cumulative cap below is what stops a window spanning most of
    // it - the peer stack's rule, judged on what is delivered rather than on offset/limit arguments.
    if (delivered >= total)
    {
        deny(
            `Blocked a whole-file read of ${path.basename(file)} (${delivered} of ${total} lines).`,
            `Blocked: whole-file read of ${file} - ${delivered} lines of a ${total}-line file. Per baseline-navigation.mdc, reading a file is `
            + `for code you have ALREADY located, never for finding a symbol. Read half the file or less per range. ${serenaHint(file)}`,
        );
    }

    const { covered, save } = coverageOf(payload.conversation_id, file, String(payload.content || ''), delivered);
    if (covered > total * COVERAGE_CAP)
    {
        deny(
            `Blocked: ranged reads of ${path.basename(file)} now cover ${Math.round((100 * covered) / total)}% of it this conversation.`,
            `Blocked: ranged reads of ${file} now cover ${Math.round((100 * covered) / total)}% of its ${total} lines this conversation - `
            + `reconstructing a large file from half-reads is the whole-file read this gate exists to stop. For the remainder: ${serenaHint(file)}`,
        );
    }

    save();
    allow();
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

    if (payload.hook_event_name === 'beforeShellExecution' || payload.command !== undefined)
    {
        currentEvent = 'beforeShellExecution';
        handleShell();
    }
    else
    {
        currentEvent = 'beforeReadFile';
        handleRead();
    }
});
