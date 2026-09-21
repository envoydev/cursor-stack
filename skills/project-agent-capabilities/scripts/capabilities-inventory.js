#!/usr/bin/env node
// capabilities-inventory.js - the whole mechanical half of /project-agent-capabilities in ONE node
// pass: the precheck, the full inventory with a printed COUNT per layer (skills, seats, rules, MCP,
// the registered MCP servers, the paste-ready MCP routing rows, the compare verdict that
// authorizes the write, and the post-write --verify. Node built-ins only - no install, no network,
// and no per-skill fork (the shell loop it replaces measured 4m13s on Git Bash).
//
// Usage, from the project root:
//   node .cursor/skills/project-agent-capabilities/scripts/capabilities-inventory.js
//   node .../capabilities-inventory.js --body <composed-rule-file|->     the compare verdict
//   node .../capabilities-inventory.js --verify <rule-file>             exits 1 on failure
//   --project <dir>   the project root (default: the current directory)
//
// Every line it prints is a report field. A claim with no printed line behind it is not one.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.resolve(__dirname, '..');
const TEMPLATE_REL = 'references/generated-rule-template.md';
const RULE_REL = '.cursor/rules/baseline-project-agent-capabilities.mdc';
// The orchestration skills that carry NO `disable-model-invocation` by design, so the architecture
// loop can invoke them - they belong with the slash-only set in the rule, marked as the exception.
const MODEL_INVOCABLE_BY_DESIGN = new Set(['project-architecture-analyzer', 'project-architecture-quality-analyzer']);
const HEAVY_NATIVE_DEPS = new Set(['chrome-devtools', 'appium-mcp']);
// One catalog server expands into one registration per kept browser; every installed-name reader
// maps them back to the catalog name, and so does the routing row.
const PLAYWRIGHT_SERVER = /^playwright-(chrome|msedge|firefox|webkit)$/;
const SEAT_ROLES = ['-solution-designer', '-implementer', '-verifier'];
const REQUIRED_HEADINGS = ['## Orchestration skills', '## Subagent seats', '## MCP routing'];

// ---------------------------------------------------------------- small IO helpers (all fail-soft)

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
const slash = (p) => p.split(path.sep).join('/');
const relTo = (root, p) => slash(path.relative(root, p));
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

function argOf(flag)
{
    const i = process.argv.indexOf(flag);
    return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function today()
{
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------- frontmatter, parsed by NODE

// A PyYAML import is not available everywhere and a run that died on ModuleNotFoundError still
// reported 'frontmatter parses' - so the parse is here, over the flat `key: value` block these
// rules and skills actually carry, and it says WHY it failed.
function parseFrontmatter(text)
{
    if (text === null) return { ok: false, error: 'file unreadable' };
    const lines = text.split(/\r?\n/);
    if (lines[0] !== '---') return { ok: false, error: 'no opening `---` on line 1' };
    const end = lines.indexOf('---', 1);
    if (end === -1) return { ok: false, error: 'no closing `---`' };
    const keys = {};
    let last = null;
    for (let i = 1; i < end; i++)
    {
        const line = lines[i];
        if (line.trim() === '') continue;
        const m = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
        if (m)
        {
            if (Object.prototype.hasOwnProperty.call(keys, m[1])) return { ok: false, error: `duplicate key \`${m[1]}\`` };
            last = m[1];
            keys[last] = m[2];
        }
        else if (last && /^[ \t]+\S/.test(line)) keys[last] += ` ${line.trim()}`;
        else return { ok: false, error: `line ${i + 1} is not \`key: value\`: ${collapse(line).slice(0, 60)}` };
    }
    if (Object.keys(keys).length === 0) return { ok: false, error: 'the frontmatter block is empty' };
    return { ok: true, keys, bodyFrom: end + 1 };
}

// The row is a ROUTER, not the skill's documentation: house first sentences run 460-588 chars, so
// the cap is the first CLAUSE at 120.
function firstClause(desc)
{
    if (!desc) return '';
    const d = collapse(desc).replace(/^["']/, '').replace(/["']$/, '');
    return d.split(/\.\s|\s-\s/)[0].slice(0, 120).trim();
}

// ---------------------------------------------------------------- the layers

function scanSkills(dir)
{
    const out = [];
    for (const e of readDir(dir))
    {
        if (!e.isDirectory()) continue;
        const text = readText(path.join(dir, e.name, 'SKILL.md'));
        if (text === null) continue;
        const fm = parseFrontmatter(text);
        const keys = fm.ok ? fm.keys : {};
        const name = collapse(keys.name || e.name);
        out.push({
            name,
            slashOnly: /^true$/i.test(collapse(keys['disable-model-invocation'] || '')),
            byDesign: MODEL_INVOCABLE_BY_DESIGN.has(name),
            clause: firstClause(keys.description),
            unreadable: fm.ok ? null : fm.error,
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

const scanAgents = (dir) => readDir(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.replace(/\.md$/, ''))
    .sort((a, b) => a.localeCompare(b));

function seatFamilies(seats)
{
    const fams = new Set();
    for (const s of seats) for (const role of SEAT_ROLES) if (s.endsWith(role)) fams.add(s.slice(0, -role.length));
    return [...fams].sort((a, b) => a.localeCompare(b));
}

function scanRules(dir)
{
    const out = [];
    for (const e of readDir(dir))
    {
        // Cursor rules are `.mdc` and declare their scope with `globs:` (a bare string or a list),
        // not the peer stack's `paths:`. `alwaysApply: true` is the pathless form.
        if (!e.isFile() || !e.name.endsWith('.mdc')) continue;
        const fm = parseFrontmatter(readText(path.join(dir, e.name)));
        const raw = fm.ok ? (fm.keys.globs || '') : '';
        const always = fm.ok && /^true$/i.test(String(fm.keys.alwaysApply || '').trim());
        const globs = (raw && !always) ? collapse(raw).replace(/^\[|\]$/g, '').split(',').map((g) => g.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
        out.push({ name: e.name.replace(/\.mdc$/, ''), globs, pathScoped: globs.length > 0 });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- the routing map

const routingKey = (name) => (PLAYWRIGHT_SERVER.test(name) ? 'playwright' : name);

function routingMap()
{
    const lines = (readText(path.join(SKILL_DIR, TEMPLATE_REL)) || '').split(/\r?\n/);
    const start = lines.findIndex((l) => /^The routing map/.test(l));
    const map = new Map();
    if (start === -1) return map;
    let cur = null;
    for (let i = start + 1; i < lines.length; i++)
    {
        const l = lines[i];
        if (/^#{1,6} /.test(l)) break;
        if (/^- /.test(l))
        {
            const m = /^- `([^`]+)`/.exec(l);
            cur = { key: m ? m[1] : null, text: l.trim() };
            if (cur.key) map.set(cur.key, cur);
        }
        else if (cur && /^[ \t]+\S/.test(l)) cur.text += ` ${l.trim()}`;
        else if (l.trim() === '') cur = null;
    }
    return map;
}

function routingRow(name, map)
{
    const key = routingKey(name);
    const hit = map.get(key);
    if (!hit) return `- \`${name}\` - routing: see project docs; its \`mcp_${name}_*\` tools are in this session's own tool list.`;
    let row = collapse(hit.text).replace(/<server>/g, name);
    if (key !== name) row = row.replace(`\`${key}\``, `\`${name}\``);
    return row;
}

// ---------------------------------------------------------------- the project, and the live rule

function docsRoot(projectRoot)
{
    for (const key of ['CURSOR_DOCS_PATH'])
    {
        if (process.env[key]) return { value: process.env[key], from: `${key} in the environment` };
    }
    try
    {
        const env = (JSON.parse(readText(path.join(projectRoot, '.cursor', 'settings.json')) || '{}') || {}).env || {};
        for (const key of ['CURSOR_DOCS_PATH'])
        {
            if (env[key]) return { value: env[key], from: `${key} in .cursor/settings.json env` };
        }
    }
    catch { /* a malformed settings.json is the default's case, not a failure */ }
    return { value: '.cursor/docs', from: 'the default - no CURSOR_DOCS_PATH set' };
}

function installStamp(projectRoot)
{
    const text = readText(path.join(projectRoot, '.cursor', 'cursor-stack.stamp'));
    if (text === null) return null;
    const pick = (k) => (new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(text) || [])[1];
    const sha = (pick('sha') || '').trim();
    const version = (pick('version') || '').trim();
    if (!sha && !version) return null;
    return `${version || 'no version'}@${sha.slice(0, 7) || 'no sha'}`;
}

// The precheck the shell form could never make print empty: its `find ... -newer` listed the start
// DIRECTORIES, whose mtime moves on every child create or rename (the rule's own save included),
// and `head -3` then filled with those three directories and hid the real changed files. FILES
// only, the generated rules excluded, newest first, and a COUNT before the names.
function precheck(projectRoot, rulePath)
{
    const ruleStat = statOf(rulePath);
    if (!ruleStat) return { first: true, hits: [] };
    const skipName = (n) => n.startsWith('baseline-project-') || n === 'project-code-style.mdc';
    const hits = [];
    const visit = (p, depth) =>
    {
        const st = statOf(p);
        if (!st) return;
        if (st.isDirectory())
        {
            if (depth > 6) return;
            for (const e of readDir(p)) visit(path.join(p, e.name), depth + 1);
            return;
        }
        if (!st.isFile() || skipName(path.basename(p)) || path.resolve(p) === path.resolve(rulePath)) return;
        if (st.mtimeMs > ruleStat.mtimeMs) hits.push({ path: relTo(projectRoot, p), mtime: st.mtimeMs });
    };
    for (const src of ['.cursor/skills', '.cursor/agents', '.cursor/rules', '.cursor/mcp.json', '.cursor/cursor-stack.stamp'])
    {
        visit(path.join(projectRoot, src), 0);
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    return { first: false, hits, captured: ((/^Captured:\s*(.+)$/m.exec(readText(rulePath) || '') || [])[1] || 'no Captured: line').trim() };
}

const sectionsOf = (text) =>
{
    const map = new Map();
    let head = '(preamble)';
    let buf = [];
    for (const line of (text || '').split(/\r?\n/))
    {
        if (/^## /.test(line)) { map.set(head, buf.join('\n').trim()); head = line.trim(); buf = []; }
        else buf.push(line);
    }
    map.set(head, buf.join('\n').trim());
    return map;
};

const normalize = (t) => (t || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n');

// The policy block ships VERBATIM from the skill - it is the ONE home of the house usage policy and
// its `policy-rev` stamp is what tells a current copy from a two-release-old one. The skill's copy
// carries the `<docs-path>` placeholder the generated rule must resolve, so the comparison puts it
// back before it compares.
function policyBlock(text)
{
    const lines = (text || '').split(/\r?\n/);
    const at = lines.findIndex((l) => /<!--\s*policy-rev:\s*[0-9a-f]+\s*-->/.test(l));
    if (at === -1) return { rev: null, lines: [] };
    const rev = (/policy-rev:\s*([0-9a-f]+)/.exec(lines[at]) || [])[1];
    const body = [];
    for (let i = at + 1; i < lines.length; i++)
    {
        if (/^#{1,6} /.test(lines[i]) || /^```/.test(lines[i])) break;
        body.push(lines[i]);
    }
    return { rev, lines: body.map((l) => l.trim()).filter(Boolean) };
}

function mcpRowsOf(text)
{
    const lines = (text || '').split(/\r?\n/);
    const at = lines.findIndex((l) => /^## MCP routing\s*$/.test(l));
    if (at === -1) return null;
    const rows = [];
    for (let i = at + 1; i < lines.length; i++)
    {
        const l = lines[i];
        if (/^## /.test(l)) break;
        if (/^- /.test(l)) rows.push(l.trim());
        else if (rows.length && /^[ \t]+\S/.test(l)) rows[rows.length - 1] += ` ${l.trim()}`;
    }
    return rows;
}

// ---------------------------------------------------------------- the three modes

function report(projectRoot)
{
    const out = [];
    const say = (label, value) => out.push(`${(`${label}:`).padEnd(11)}${value}`);
    const sub = (line) => out.push(`  ${line}`);

    const rulePath = path.join(projectRoot, RULE_REL);
    const ruleText = readText(rulePath);
    const docs = docsRoot(projectRoot);
    const stamp = installStamp(projectRoot);
    const map = routingMap();
    const skillPolicy = policyBlock(readText(path.join(SKILL_DIR, 'SKILL.md')));

    out.push('=== project-agent-capabilities - inventory (one node pass, no per-skill fork) ===');
    say('PROJECT', projectRoot);
    say('DOCS ROOT', `${docs.value}  (from ${docs.from}) - every \`<docs-path>\` in the template is this literal`);
    say('CAPTURED', `${today()} from ${stamp || 'no stamp'}`);
    say('TEMPLATE', `${TEMPLATE_REL} - ${map.size} routing rows read`);

    const liveRev = policyBlock(ruleText).rev;
    say('RULE', ruleText === null
        ? `${RULE_REL} - absent, this is the FIRST capture`
        : `${RULE_REL} - ${Buffer.byteLength(ruleText)} bytes, policy-rev ${liveRev || 'none'} (skill: ${skillPolicy.rev || 'none'}${liveRev && skillPolicy.rev ? (liveRev === skillPolicy.rev ? ', current' : ', STALE - the stamped policy moved') : ''})`);

    const pre = precheck(projectRoot, rulePath);
    if (pre.first) say('PRECHECK', 'FIRST - no rule yet, capture everything');
    else if (pre.hits.length === 0) say('PRECHECK', `empty - 0 files newer than the rule (Captured: ${pre.captured}). Say so in one line and STOP, unless the user asked for a refresh, or an MCP server configured outside this tree changed.`);
    else
    {
        say('PRECHECK', `drift - ${pre.hits.length} file(s) newer than the rule (Captured: ${pre.captured})`);
        for (const h of pre.hits.slice(0, 3)) sub(h.path);
        if (pre.hits.length > 3) sub(`... and ${pre.hits.length - 3} more`);
    }

    // Cursor has no plugin layer: `.cursor/skills` and `.cursor/agents` ARE the inventory, so an
    // empty pair is an empty install, not a covered one.
    const skills = scanSkills(path.join(projectRoot, '.cursor', 'skills'));
    const seats = scanAgents(path.join(projectRoot, '.cursor', 'agents'));
    if (skills.length === 0 || seats.length === 0)
        say('SOURCE', 'no local .cursor/skills or .cursor/agents - say so and STOP rather than generate an empty rule over a good one');

    const orchestration = skills.filter((s) => s.slashOnly || s.byDesign);
    say('SKILLS', `${skills.length} total, ${orchestration.length} orchestration (${orchestration.filter((s) => s.byDesign).length} model-invocable-by-design)`);
    for (const s of orchestration) sub(`/${s.name} - ${s.clause}${s.byDesign ? ' (model-invocable-by-design)' : ''}`);
    for (const s of skills.filter((s) => s.unreadable)) sub(`UNREADABLE ${s.name}: ${s.unreadable} - report it as unreadable, never fill it from memory`);

    say('SEATS', `${seats.length} total`);
    sub(seats.join(', ') || 'none');
    const fams = seatFamilies(seats);
    sub(`seat families (${fams.length}): ${fams.join(', ') || 'none'}`);

    const rules = scanRules(path.join(projectRoot, '.cursor', 'rules'));
    const scoped = rules.filter((r) => r.pathScoped);
    say('RULES', `${rules.length} total, ${rules.length - scoped.length} pathless, ${scoped.length} path-scoped`);
    sub(`pathless: ${rules.filter((r) => !r.pathScoped).map((r) => r.name).join(', ') || 'none'}`);
    for (const r of scoped) sub(`path-scoped: ${r.name} [${r.globs.join(', ')}]`);
    sub('coverage: cross-check the seat families above against these path-scoped rows - a family whose stack no rule names is a flag row');

    let registered = [];
    let mcpNote = '';
    const mcpRaw = readText(path.join(projectRoot, '.cursor', 'mcp.json'));
    if (mcpRaw === null) mcpNote = 'no .cursor/mcp.json';
    else
    {
        try { registered = Object.keys(JSON.parse(mcpRaw).mcpServers || {}).sort(); }
        catch (err) { mcpNote = `.cursor/mcp.json UNREADABLE (${err.message}) - report it as unreadable`; }
    }
    // Cursor ships no MCP list CLI, so the FILE is all a script can read. The live side is the
    // session's own `mcp_<server>_` tool namespaces, which only the model can see - the report says
    // so rather than writing a negative claim the file cannot support.
    say('MCP', `${registered.length} registered in .cursor/mcp.json${mcpNote ? ` (${mcpNote})` : ''} - the LIVE side is this session's own mcp_<server>_ tool namespaces, which no script can read: check them yourself before any 'not registered' claim`);
    for (const name of registered) sub(`${name.padEnd(20)} registered${routingKey(name) !== name ? `  routing: ${routingKey(name)}` : ''}`);
    const heavy = registered.filter((n) => HEAVY_NATIVE_DEPS.has(n));
    sub(`heavy native deps registered: ${heavy.join(', ') || 'none'}`);
    sub('MCP ROUTING rows - paste verbatim, one per REGISTERED server:');
    for (const name of registered) sub(routingRow(name, map));

    say('COMPARE', 'no --body yet - compose the rule body, write it to a scratch file, then re-run with `--body <file>`; that verdict is what authorizes the write');
    console.log(out.join('\n'));
    return 0;
}

function compare(projectRoot, bodyArg)
{
    const rulePath = path.join(projectRoot, RULE_REL);
    const composed = normalize(bodyArg === '-' ? fs.readFileSync(0, 'utf8') : readText(path.resolve(bodyArg)));
    if (composed === null || composed.trim() === '')
    {
        console.log(`COMPARE:   FAIL - the composed body at ${bodyArg} is empty or unreadable`);
        return 1;
    }
    const live = readText(rulePath);
    if (live === null)
    {
        console.log(`COMPARE:   differs - no rule yet, WRITE ${RULE_REL} (composed ${Buffer.byteLength(composed)} bytes)`);
        return 0;
    }
    if (normalize(live) === composed)
    {
        console.log(`COMPARE:   identical - DO NOT WRITE (${Buffer.byteLength(live)} bytes). Report \`rule unchanged - ${Buffer.byteLength(live)} bytes, not rewritten\`.`);
        return 0;
    }
    const a = sectionsOf(normalize(live));
    const b = sectionsOf(composed);
    const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
    console.log(`COMPARE:   differs - WRITE ${RULE_REL} in ONE call, whole file (live ${Buffer.byteLength(live)} bytes, composed ${Buffer.byteLength(composed)} bytes)`);
    console.log(`  sections changed: ${changed.join(' | ') || '(whitespace only)'}`);
    return 0;
}

function verify(projectRoot, ruleArg)
{
    const rulePath = path.resolve(ruleArg);
    const text = readText(rulePath);
    const fails = [];
    const line = (label, ok, detail) =>
    {
        if (!ok) fails.push(label);
        console.log(`${(`${label}:`).padEnd(15)}${ok ? 'ok' : 'FAIL'} - ${detail}`);
    };
    console.log(`=== verify ${slash(path.relative(projectRoot, rulePath)) || rulePath} ===`);
    if (text === null || text.trim() === '')
    {
        console.log('file:          FAIL - absent or empty');
        console.log('VERIFY:        FAIL (1 check)');
        return 1;
    }

    const fm = parseFrontmatter(text);
    line('frontmatter', fm.ok, fm.ok ? `parsed by node, keys: ${Object.keys(fm.keys).join(', ')}` : fm.error);
    line('description', !!(fm.ok && fm.keys.description), fm.ok && fm.keys.description ? 'present' : 'the generated rule needs a `description:` key');
    line('paths key', !(fm.ok && Object.prototype.hasOwnProperty.call(fm.keys, 'paths')), fm.ok && fm.keys.paths ? 'present - this rule is PATHLESS, a `paths:` key makes it a scoped rule' : 'absent, as a pathless rule needs');

    const skillPolicy = policyBlock(readText(path.join(SKILL_DIR, 'SKILL.md')));
    const rulePolicy = policyBlock(text);
    line('policy-rev', !!(rulePolicy.rev && skillPolicy.rev && rulePolicy.rev === skillPolicy.rev),
        rulePolicy.rev ? `${rulePolicy.rev} vs the skill's ${skillPolicy.rev || 'none'}` : 'no `<!-- policy-rev: ... -->` line - the stamped block was not copied with it');

    const docs = docsRoot(projectRoot).value;
    const back = rulePolicy.lines.map((l) => l.split(docs).join('<docs-path>'));
    const diffAt = skillPolicy.lines.findIndex((l, i) => back[i] !== l);
    const sameLen = back.length === skillPolicy.lines.length;
    line('policy block', sameLen && diffAt === -1,
        sameLen && diffAt === -1 ? `${back.length} lines, verbatim from the skill (\`<docs-path>\` resolved to ${docs})`
            : `differs from the skill at line ${diffAt === -1 ? back.length + 1 : diffAt + 1} of the block - it ships VERBATIM, re-copy it`);

    const missing = REQUIRED_HEADINGS.filter((h) => !new RegExp(`^${h}`, 'm').test(text));
    line('headings', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED_HEADINGS.length} inventory sections present`);

    const rows = mcpRowsOf(text);
    const bad = (rows || []).filter((r) => !/^- `[^`]+`\s+-\s+\S/.test(r));
    line('mcp rows', rows !== null && bad.length === 0,
        rows === null ? 'no `## MCP routing` section'
            : bad.length ? `${bad.length} of ${rows.length} name no server and no routing - ${bad.map((r) => r.slice(0, 40)).join(', ')}`
                : `${rows.length} of ${rows.length} name their server and its routing`);

    console.log(`VERIFY:        ${fails.length ? `FAIL (${fails.length} check(s): ${fails.join(', ')})` : 'PASS'}`);
    return fails.length ? 1 : 0;
}

// ---------------------------------------------------------------- entry

function main()
{
    if (process.argv.includes('--help') || process.argv.includes('-h'))
    {
        console.log(readText(__filename).split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
        return 0;
    }
    const projectRoot = path.resolve(argOf('--project') || process.cwd());
    const ruleArg = argOf('--verify');
    if (process.argv.includes('--verify') && !ruleArg) { console.log('--verify needs a rule file path'); return 2; }
    if (ruleArg) return verify(projectRoot, ruleArg);
    const bodyArg = argOf('--body');
    if (process.argv.includes('--body') && !bodyArg) { console.log('--body needs a file path (or `-` for stdin)'); return 2; }
    if (bodyArg) return compare(projectRoot, bodyArg);
    return report(projectRoot);
}

process.exitCode = main();
