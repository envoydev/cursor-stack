#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// Cursor `beforeShellExecution` hook: block a recursive `rm` of a catastrophic, unrecoverable
// target, and the git verbs that destroy a working tree with no reflog to recover from. The
// filesystem has no reflog, so this is the rm analog of guard-protected-force-push.js - a
// deterministic, catastrophic, irreversible event enforced by a hook, not left to prose.
// Reads { command, cwd?, workspace_roots? } on stdin, answers { permission }.
//
// Scope is deliberately narrow - it fires ~never in normal work. A recursive rm
// (-r / -R / --recursive, with or without -f) is blocked when a target is:
//   - the filesystem root:   /   /.   or   /*
//   - the home directory:    ~   ~/   ~/*   $HOME   ${HOME}   $HOME/*   (quoted too,
//     including a quoted prefix with the glob outside: "$HOME"/* )
//   - the current dir itself:  *   ./*   .   ./   $PWD   ${PWD}   $PWD/*
//   - the parent dir:  ..   ../   ../*   (wipes the cwd and every sibling beside it)
// '..' and '.' segments are collapsed first, so a path that resolves to root (`/home/../`)
// or to the cwd (`./.`) is caught despite the literal text never being `/` or `.`. A recursive
// rm is also blocked when it names MULTIPLE single-segment absolute paths (`/usr /lib /etc`) -
// the multi-arg system wipe each dir dodges individually.
//
// The GIT half was added with the peer stack's v0.2.55 audit: `git checkout --` / `restore` /
// `reset --hard` / `clean -f` destroy uncommitted work with no reflog behind them, and the guard
// had zero coverage of them - a destructive `git checkout --` passed every guard in the stack.
// It blocks only when the tree is actually DIRTY, so a clean checkout passes untouched.
//
// Out of scope (same honesty as the force-push guard): indirection that deletes without a literal
// recursive `rm` of one of these targets - `find ... -delete`, `xargs rm`, `eval`, a subshell, or
// rm via a wrapper script - is NOT caught here; this guard reads the literal command's flat tokens.
'use strict';
const fs = require('fs');
// The docs root env value - where the block ledger below is written.
const docsRootEnv = () => process.env.CURSOR_DOCS_PATH || '.cursor/docs';

// A heredoc body is DATA, not shell: a plan or checklist that merely DESCRIBES this command is
// inert text, and matching it blocked a document write for its own prose (reproduced). Blank the
// payload spans, keeping the character count so any index into the command still holds.
const stripHeredocs = (c) => String(c).replace(
  /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
  (m) => m.replace(/[^\n]/g, ' '),
);

// Split a compound command (`a && rm -rf / ; b`) into segments so each `rm` is
// inspected on its own. Best-effort: subshell/expansion forms fall through to allow.
const SEPARATORS = /[;|&]{1,2}|\n/;

// A recursive flag: --recursive, or a combined short cluster containing r/R
// (-r, -R, -rf, -fr, -Rf, -rfv). --force alone never recurses, so it does not count.
function hasRecursive(args)
{
    return args.some(t => t === '--recursive' || (/^-[A-Za-z]+$/.test(t) && /[rR]/.test(t)));
}

// Strip one layer of surrounding quotes.
function unquote(tok)
{
    const t = tok.trim();
    if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))))
    {
        return t.slice(1, -1);
    }

    return t;
}

// Clean a token down to its comparable path: strip ALL quote characters - not just a
// fully-wrapping pair - so a quoted prefix with the glob outside the quotes (`"$HOME"/*`)
// collapses to the same '$HOME/*' as the unquoted form. Then collapse any '..' segments
// (literal-string matching would let '/home/../' and '/usr/../' resolve away to '/' at run
// time yet read as non-catastrophic here) and drop a trailing slash ('~/' -> '~'). $HOME
// stays literal because the string is unexpanded.
function cleanTarget(tok)
{
    let t = unquote(tok).replace(/['"]/g, '');
    const absolute = t.startsWith('/');
    const trailingGlob = /\/\*$/.test(t);
    // Collapse '..' against earlier segments; '/home/..' -> '', './a/..' -> '.', 'a/../..' -> '..'.
    const out = [];
    for (const seg of t.split('/'))
    {
        if (seg === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '')
        {
            out.pop();
        }
        else
        {
            out.push(seg);
        }
    }
    t = out.join('/');
    // A collapse that emptied an absolute path leaves bare '/' (or '/*' if it ended in a glob).
    if (absolute && (t === '' || t === '/'))
    {
        t = trailingGlob ? '/*' : '/';
    }

    return t.replace(/\/+$/, '') || (absolute ? '/' : t);
}

// Catastrophic, unrecoverable single targets: root, home, or a bare whole-dir glob.
function isCatastrophic(tok)
{
    // Drop '.' path segments (a no-op in a path) so './.', '././', and './*' read the
    // same as the bare cwd targets, then compare against the unrecoverable literals.
    const cleaned = (cleanTarget(tok) || '/').split('/').filter(s => s !== '.').join('/');
    const t = cleaned === '' ? '.' : cleaned;

    return t === '/' || t === '/*' || t === '/.'
        || t === '~' || t === '~/*'
        || t === '$HOME' || t === '${HOME}' || t === '$HOME/*' || t === '${HOME}/*'
        || t === '$PWD' || t === '${PWD}' || t === '$PWD/*' || t === '${PWD}/*'
        || t === '*' || t === './*' || t === '.' || t === '..' || t === '../*';
}

// A single-segment absolute path ('/usr', '/etc', '/var') - non-catastrophic alone, but
// a recursive rm naming TWO OR MORE of them is a system wipe each arg dodges individually.
function isTopLevelDir(tok)
{
    return /^\/[^/]+$/.test(cleanTarget(tok));
}

// True if any segment is a recursive rm naming a catastrophic target, or naming
// several top-level system dirs at once.
function isCatastrophicRm(command)
{
    for (const seg of command.split(SEPARATORS))
    {
        const tokens = seg.trim().split(/\s+/).filter(Boolean);
        // Skip leading env-assignments and benign prefixes so `rm` must be the segment's COMMAND,
        // not an argument to another program (no false positive on `echo rm -rf /` or a commit msg).
        let i = 0;
        while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])
            || tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'nice' || tokens[i] === 'time'))
        {
            i++;
        }

        const cmd = tokens[i];
        if (!cmd || !(cmd === 'rm' || cmd.endsWith('/rm')))
        {
            continue;
        }

        const args = tokens.slice(i + 1);
        if (!hasRecursive(args))
        {
            continue;
        }

        const paths = args.filter(a => !a.startsWith('-'));
        if (paths.some(isCatastrophic) || paths.filter(isTopLevelDir).length >= 2)
        {
            return true;
        }
    }

    return false;
}


// --- Cursor hooks.json v1 contract ------------------------------------------------------------
// beforeShellExecution answers with a permission object on stdout - there is no exit-2 denial and
// no stderr channel back to the model, so the reason has to travel inside the response.
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
        const path = require('path');
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
            tool: 'shell',
            reason: String(reason).split('\n')[0].slice(0, 200),
        }) + '\n');
    }
    catch { /* telemetry is never allowed to break the gate */ }
}

function deny(userMessage, agentMessage)
{
    ledger('beforeShellExecution', agentMessage);
    respond({ permission: 'deny', user_message: userMessage, agent_message: agentMessage });
}

function readPayload()
{
    try
    {
        payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    }
    catch
    {
        allow(); // can't parse hook input -> don't block on a harness malfunction
    }
    if (!payload || typeof payload !== 'object')
    {
        allow(); // a JSON scalar/null - nothing to judge
    }
}

function main()
{
    readPayload();

    const command = stripHeredocs(payload.command ?? '');

    // Git destroys uncommitted work with no undo, and this guard had ZERO git coverage: a
    // destructive `git checkout --` passed every guard in the stack. These four verbs are the same
    // class as a recursive rm - the working tree is the only copy - and unlike a commit there is no
    // reflog entry to recover from. Gated on ACTUAL loss: a clean tree has nothing to destroy, so
    // the command passes, which keeps the guard silent in the common case of resetting a clean
    // checkout.
    const destructiveGit = /(?:^|[;&|(]\s*|\s)git(?:\s+-[cC]\s*\S+|\s+--\S+)*\s+(?:checkout\s+(?:--\s|\.(?:\s|$))|restore\s+(?!(?:--staged|--source)\b)|reset\s+--hard\b|clean\s+-\S*[fx])/;
    // A QUOTED span is data, exactly as it is in the commit guard: an echo, a plan sentence or a
    // grep pattern that merely CONTAINS `git reset --hard` invokes nothing, and denying it teaches
    // the obfuscation that then defeats this gate on a real one. The fill is a NON-space so the
    // span stays one opaque argument token and the offsets survive.
    const gitScan = command
        .replace(/'[^'\n]*'/g, (m) => m.replace(/[^\n]/g, 'x'))
        .replace(/"[^"\n]*"/g, (m) => m.replace(/[^\n]/g, 'x'));
    if (destructiveGit.test(gitScan))
    {
        let dirty = '';
        try
        {
            const { execSync } = require('child_process');
            const root = payload.cwd || (payload.workspace_roots || [])[0] || process.cwd();
            dirty = execSync('git status --porcelain', { cwd: root, timeout: 5000 }).toString().trim();
        }
        catch { dirty = ''; } // not a git repo / git unavailable - never block on our own failure
        if (dirty)
        {
            const rows = dirty.split('\n');
            deny(
                `Blocked: this discards uncommitted work in ${rows.length} file(s), and there is no reflog for a working tree.`,
                `Blocked: this discards uncommitted work in ${rows.length} file(s), and there is no reflog for a\n` +
                `working tree - once it is gone it is gone (AGENTS.md's rm rule, same class).\n` +
                rows.slice(0, 10).map((r) => `  ${r}`).join('\n') +
                (rows.length > 10 ? `\n  ... and ${rows.length - 10} more` : '') +
                `\n\nIf the loss is intended, say so to the user first and get their word. Otherwise keep the\n` +
                `work: \`git stash -u\` (recoverable), or commit it, or name the ONE file to revert instead of\n` +
                `the whole tree. A clean tree passes this gate untouched.`,
            );
        }
    }

    if (!isCatastrophicRm(command))
    {
        allow();
    }

    deny(
        'Blocked a recursive rm of a catastrophic target (/, ~, $HOME, the cwd or its parent, a bare *, or several top-level system dirs).',
        'Refusing a recursive rm of a catastrophic, unrecoverable target (/, ~, $HOME, the cwd or its ' +
        'parent, a bare *, or several top-level system dirs at once) - the filesystem has no reflog (AGENTS.md). ' +
        'Delete a specific subdirectory by name instead.',
    );
}

main();
