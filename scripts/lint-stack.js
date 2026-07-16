#!/usr/bin/env node
// Repo lint: keep the Cursor stack's registration surfaces in sync. The
// installer is split into two manifests - cursor-stack.{sh,ps1} - and the
// skills are vendored in this repo under skills/ and cloned from here at
// install, so the installer is self-sourcing (STACK_SKILLS_REPO overrides).
// This lint proves everything THIS repo can prove locally:
//   1. the .sh/.ps1 twins agree on SKILLS (same set, same order) and MCPS;
//   2. neither installer carries a PLUGINS block entry (Cursor has no
//      /plugin install - plugins map to natives/extensions/MCPs);
//   3. the on-disk agents/*.md, rules/*.mdc, and hooks/*.js sets equal the
//      CURSOR_AGENTS / CURSOR_RULES / CURSOR_HOOKS manifest arrays in BOTH
//      shells - a drift means a committed file never installs, or the
//      installer fetches a file that no longer exists (they are fetched
//      from THIS repo's main branch at install);
//   4. cursor-stack.html agrees with the manifests: personal skill rows ==
//      the active envoydev/cursor-stack entries, repository rows == the
//      third-party + commented inventory, hooksRules rows == the hook +
//      rule arrays, agent rows == CURSOR_AGENTS;
//   5. headline Skills/MCP/Hooks/Rules/Agents counts in README.md equal
//      the manifest/array sizes (the prose numbers cannot silently lie);
//   6. the vendored skills/ dirs equal the active manifest entries and
//      each carries a SKILL.md (a manifest entry with no dir installs
//      nothing; a dir with no entry is never copied), whose frontmatter
//      loads, declares name == folder + a description, and carries only
//      fields Cursor's schema defines - a block a YAML parser cannot load
//      drops the skill from the registry SILENTLY, and a model:/effort:
//      pin from the peer stack never fires;
//   7. a backticked skill name in skills/**/*.md, agents/*.md, rules/*.mdc,
//      or AGENTS.template.md resolves to a known skill (any manifest entry,
//      active or commented), an MCP, an agent name, or the explicit
//      non-skill allowlist - a renamed skill would otherwise rot silently;
//   8. no peer-stack framing on any surface that reaches a consuming project
//      or a reader (skills/agents/rules/hooks/README/HTML/template/installers)
//      - a fix ported from the sibling repo must not drag its framing back;
//      the ${CLAUDE_PROJECT_DIR}/${CLAUDE_CONFIG_DIR} path tokens and the
//      CLAUDE.md filename are the allowed exceptions;
//   9. no false 'Vendored from' label on a dotnet-* HTML line (house
//      dotnet-* skills are original work).
// No dependencies. Run: node scripts/lint-stack.js
//   -> exit 0 clean, 1 with findings.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// The installer twins live beside this lint in scripts/; everything else is repo-root.
const CURSOR_SH = path.join(__dirname, 'cursor-stack.sh');
const CURSOR_PS1 = path.join(__dirname, 'cursor-stack.ps1');
const README = path.join(ROOT, 'README.md');
const STACK_HTML = path.join(ROOT, 'cursor-stack.html');
const AGENTS_DIR = path.join(ROOT, 'agents');
const RULES_DIR = path.join(ROOT, 'rules');
const HOOKS_DIR = path.join(ROOT, 'hooks');
const SKILLS_DIR = path.join(ROOT, 'skills');
const SCRIPTS_DIR = __dirname;   // the installer twins + standalone utilities live beside this lint
const TEMPLATE = path.join(ROOT, 'templates', 'AGENTS.template.md');

// The single files every check below assumes. They are NOT optional: a missing one
// used to be dropped by a `.filter(fs.existsSync)` further down, which silently
// un-scanned it - when the template moved to templates/, the backtick scan AND the
// no-framing guard stopped reading it and the lint still reported clean. Fail loudly
// instead: a required file that moved is a bug, never a skip.
const REQUIRED_FILES = [
    [CURSOR_SH, 'installer (.sh)'],
    [CURSOR_PS1, 'installer (.ps1)'],
    [README, 'README'],
    [STACK_HTML, 'HTML inventory'],
    [TEMPLATE, 'base template'],
];

// Backticked kebab-case tokens that look like skill names but are not
// (code identifiers, generated rule names, MCP servers). The master list -
// this is the subset the CURSOR surfaces (agents/rules/template) actually
// use, so there is no reverse dead-entry check here (an entry can be a real
// skill and simply unused on those surfaces).
const NON_SKILL_TOKENS = new Set([
    'disable-model-invocation',          // SKILL.md frontmatter field named in prose
    'baseline-project-architecture',     // generated per-project awareness rule, not a skill
    'baseline-project-related-context',  // generated per-project awareness rule, not a skill
    'baseline-project-capabilities',     // generated per-project awareness rule, not a skill
    'project-code-style',                // generated per-project code-style rule, not a skill
    'dotnet-repair-agents',              // installed .mdc repair-router rule, not a skill
    'angular-repair-agents',             // installed .mdc repair-router rule, not a skill
    'general-purpose',                   // built-in agent type named in the template
    // Third-party names the skills quote: packages, CLI tools, framework
    // selectors, and one concept. None are skills; all are real things.
    'axe-core',                          // a11y test package (angular-conventions)
    'jest-axe',                          // a11y test package (angular-conventions)
    'mat-button',                        // Angular Material selector
    'mat-raised-button',                 // Angular Material selector
    'mat-flat-button',                   // Angular Material selector
    'mat-stroked-button',                // Angular Material selector
    'app-order-list',                    // example component selector in a snippet
    'order-list',                        // example component selector in a snippet
    'uuid-ossp',                         // PostgreSQL extension (database-conventions)
    'dotnet-dump',                       // .NET CLI diagnostic tool
    'dotnet-gcdump',                     // .NET CLI diagnostic tool
    'kebab-case',                        // a naming convention, named in prose
]);

const findings = [];

function flag(message)
{
    findings.push(message);
}

// Parse "repo|skill" entries from the SKILLS block of an installer manifest
// (MCP entries share the same "a|b" line format, so scope to the block).
// Commented entries are still inventory (resolvable references), not installs.
function parseManifest(file, quote, blockStart)
{
    const active = new Map();    // skill -> repo
    const commented = new Map();
    const entry = new RegExp(`^\\s*(#?)\\s*${quote}([^|${quote}]+)\\|([^${quote}]+)${quote}`);
    let inBlock = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n'))
    {
        if (!inBlock)
        {
            inBlock = line.trimEnd().endsWith(blockStart);
            continue;
        }

        if (line.trim() === ')')
        {
            break;
        }

        const m = line.match(entry);
        if (m)
        {
            (m[1] === '#' ? commented : active).set(m[3], m[2]);
        }
    }

    return { active, commented };
}

// Collect the active (uncommented) quoted entries of a simple string-array
// block (CURSOR_AGENTS / CURSOR_HOOKS / CURSOR_RULES) - one quoted token per
// line, block ends at ')'. For entries carrying a '::'/'|' tail, the leading
// token is taken. Returns the ordered list of active entry names.
function parseStringArray(file, quote, blockStart)
{
    const names = [];
    const quoted = new RegExp(`^\\s*(#?)\\s*${quote}([^${quote}]+)${quote}`);
    let inBlock = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n'))
    {
        if (!inBlock)
        {
            inBlock = line.trimEnd().endsWith(blockStart);
            continue;
        }

        if (line.trim() === ')')
        {
            break;
        }

        const m = line.match(quoted);
        if (m && m[1] !== '#')
        {
            names.push(m[2].split(/::|\|/)[0]);
        }
    }

    return names;
}

// Parse a flat installer block (PLUGINS / MCPS) of quoted entries. The entry's
// name is the part before `sep` ('@' for plugins, '|' for MCPs). Bare variable
// lines (e.g. "$MEMORY_ENTRY" / $MemoryEntry) are resolved by locating the
// variable's assignment elsewhere in the file. Returns empty sets if the block
// is absent (e.g. PLUGINS, which a cursor manifest must not carry).
function parseFlatBlock(file, quote, blockStart, sep)
{
    const text = fs.readFileSync(file, 'utf8');
    const active = new Set();
    const commented = new Set();
    const quoted = new RegExp(`^\\s*(#?)\\s*${quote}([^${quote}]+)${quote}`);
    const variable = /^\s*(#?)\s*"?\$([A-Za-z_][A-Za-z0-9_]*)"?\s*(#.*)?$/;
    let inBlock = false;
    for (const line of text.split('\n'))
    {
        if (!inBlock)
        {
            inBlock = line.trimEnd().endsWith(blockStart);
            continue;
        }

        if (line.trim() === ')')
        {
            break;
        }

        const resolveVar = varName =>
            text.match(new RegExp(`^\\$?${varName}\\s*=\\s*${quote}([a-z0-9-]+)\\${sep}`, 'm'))?.[1] ?? null;

        let name = null;
        let isCommented = false;
        const q = line.match(quoted);
        const v = line.match(variable);
        if (q)
        {
            name = q[2].startsWith('$') ? resolveVar(q[2].slice(1)) : q[2].split(sep)[0];
            isCommented = q[1] === '#';
        }
        else if (v)
        {
            name = resolveVar(v[2]);
            isCommented = v[1] === '#';
        }

        if (name)
        {
            (isCommented ? commented : active).add(name);
        }
    }

    return { active, commented };
}

// Every manifest in `manifests` ({label -> Set}) must hold the same entries as
// the reference (the first). Flags both-direction diffs against the reference.
function assertSameSet(what, manifests)
{
    const labels = Object.keys(manifests);
    const [refLabel, refSet] = [labels[0], manifests[labels[0]]];
    for (const label of labels.slice(1))
    {
        const set = manifests[label];
        for (const name of refSet)
        {
            if (!set.has(name))
            {
                flag(`${what} '${name}' is in ${refLabel} but not ${label}`);
            }
        }

        for (const name of set)
        {
            if (!refSet.has(name))
            {
                flag(`${what} '${name}' is in ${label} but not ${refLabel}`);
            }
        }
    }
}

function diskSet(dir, ext)
{
    return new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(ext)) : []);
}

// The five fields Cursor's SKILL.md schema defines. Anything else is dead weight
// at best (a model:/effort: pin carried over from the peer stack never fires).
const SKILL_FIELDS = new Set(['name', 'description', 'paths', 'disable-model-invocation', 'metadata']);

// Read a SKILL.md frontmatter block WITHOUT a YAML dependency (this lint stays
// dep-free so it runs on a bare checkout). Cursor loads the block with a real
// YAML parser and a block that fails to load drops the skill from the registry
// SILENTLY - no error, the skill simply stops existing. So this errs strict:
// anything it cannot confidently read is a finding, never a pass. It models the
// flat `key: value` shape the skills actually use; nesting is rejected rather
// than guessed at.
function parseFrontmatter(text)
{
    if (!text.startsWith('---\n'))
    {
        return { error: 'no frontmatter block' };
    }

    const end = text.indexOf('\n---\n', 3);
    if (end === -1)
    {
        return { error: 'frontmatter block is never terminated' };
    }

    const fields = {};
    const lines = text.slice(4, end + 1).split('\n');
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        if (line.trim() === '')
        {
            continue;
        }

        if (line.includes('\t'))
        {
            return { error: `line ${i + 1}: tab character (YAML forbids tabs)` };
        }

        if (/^\s/.test(line))
        {
            return { error: `line ${i + 1}: unexpected indentation - only flat 'key: value' is supported` };
        }

        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/);
        if (!m)
        {
            return { error: `line ${i + 1}: not a 'key: value' pair -> ${line.slice(0, 48)}` };
        }

        const [, key, raw] = m;
        const value = raw.trim();
        const quoted = value.length > 1
            && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));

        if (!quoted && (value.startsWith('"') || value.startsWith("'")))
        {
            return { error: `${key}: unbalanced quote` };
        }

        // The footgun that actually bites: an unquoted scalar containing ': '
        // reads as a nested mapping, so the load fails and the skill vanishes.
        if (!quoted && /:\s/.test(value))
        {
            return { error: `${key}: unquoted value contains ': ' - YAML will not load this block` };
        }

        // A double-quoted scalar with an unescaped inner '"' is equally fatal.
        if (quoted && value.startsWith('"') && /[^\\]"/.test(value.slice(1, -1)))
        {
            return { error: `${key}: unescaped '"' inside a double-quoted value` };
        }

        fields[key] = quoted ? value.slice(1, -1) : value;
    }

    return { fields };
}

function main()
{
    // 0. Every required file is where the lint expects it. This runs FIRST because a
    //    missing one makes every check below either crash or - worse - quietly pass:
    //    the scans at the bottom filter on fs.existsSync, so a file that MOVED just
    //    stops being scanned. Exit immediately rather than report a clean run over a
    //    surface nobody read.
    for (const [file, label] of REQUIRED_FILES)
    {
        if (!fs.existsSync(file))
        {
            flag(`${label} not found at ${path.relative(ROOT, file)} - it moved or is missing; `
                + `every check that reads it would silently skip it. Fix the path in lint-stack.js.`);
        }
    }

    if (findings.length > 0)
    {
        for (const finding of findings) console.error(`LINT: ${finding}`);
        console.error(`\n${findings.length} finding(s).`);
        process.exit(1);
    }

    // 1. SKILLS: the .sh/.ps1 twins agree on the active set...
    const skills = {
        'cursor-stack.sh':  parseManifest(CURSOR_SH, '"', 'SKILLS=('),
        'cursor-stack.ps1': parseManifest(CURSOR_PS1, "'", '$Skills = @('),
    };
    const primary = skills['cursor-stack.sh'];
    assertSameSet('skill', Object.fromEntries(
        Object.entries(skills).map(([label, m]) => [label, new Set(m.active.keys())])));

    // 1b. ...and in the SAME ORDER, not just the same set - the twins were
    //     aligned so a diff/review of one against the other stays line-for-line.
    const refOrder = [...primary.active.keys()];
    const ps1Order = [...skills['cursor-stack.ps1'].active.keys()];
    const n = Math.min(refOrder.length, ps1Order.length);
    for (let i = 0; i < n; i++)
    {
        if (ps1Order[i] !== refOrder[i])
        {
            flag(`cursor-stack.ps1 SKILLS order diverges from cursor-stack.sh at position ${i + 1}: '${ps1Order[i]}' vs '${refOrder[i]}'`);
            break;
        }
    }

    // 2. The ps1 'every skill (N)' inventory count matches active + commented entries.
    const counted = fs.readFileSync(CURSOR_PS1, 'utf8').match(/every skill \((\d+)\)/);
    if (counted)
    {
        const inventory = skills['cursor-stack.ps1'].active.size + skills['cursor-stack.ps1'].commented.size;
        if (Number(counted[1]) !== inventory)
        {
            flag(`cursor-stack.ps1 says 'every skill (${counted[1]})' but lists ${inventory} entries`);
        }
    }

    // 3. MCPS: the twins agree on the active set.
    const mcps = {
        'cursor-stack.sh':  parseFlatBlock(CURSOR_SH, '"', 'MCPS=(', '|'),
        'cursor-stack.ps1': parseFlatBlock(CURSOR_PS1, "'", '$Mcps = @(', '|'),
    };
    assertSameSet('MCP', Object.fromEntries(
        Object.entries(mcps).map(([label, m]) => [label, m.active])));
    const mcpsPrimary = mcps['cursor-stack.sh'];

    // 4. Neither installer carries an active PLUGINS entry (Cursor has no
    //    /plugin install; equivalents are natives / Open-VSX / MCPs).
    for (const [label, file, quote, blockStart] of [
        ['cursor-stack.sh', CURSOR_SH, '"', 'PLUGINS=('],
        ['cursor-stack.ps1', CURSOR_PS1, "'", '$Plugins = @('],
    ])
    {
        for (const name of parseFlatBlock(file, quote, blockStart, '@').active)
        {
            flag(`${label} should carry no plugins (Cursor has none) but lists '${name}'`);
        }
    }

    // 5. The on-disk agents/rules/hooks sets equal the manifest arrays in BOTH
    //    shells (both shells agree first, then the on-disk set equals them).
    //    These files are fetched from THIS repo's main branch at install, so a
    //    drift means a committed file never installs or a fetch 404s.
    const arrays = [
        ['agent', 'CURSOR_AGENTS=(', '$CursorAgents = @(', AGENTS_DIR, '.md', 'agents/'],
        ['rule', 'CURSOR_RULES=(', '$CursorRules = @(', RULES_DIR, '.mdc', 'rules/'],
        ['hook', 'CURSOR_HOOKS=(', '$CursorHooks = @(', HOOKS_DIR, '.js', 'hooks/'],
    ];
    const arrayCounts = {};
    for (const [what, shBlock, ps1Block, dir, ext, diskLabel] of arrays)
    {
        const sh = new Set(parseStringArray(CURSOR_SH, '"', shBlock));
        const ps1 = new Set(parseStringArray(CURSOR_PS1, "'", ps1Block));
        assertSameSet(what, { 'cursor-stack.sh': sh, 'cursor-stack.ps1': ps1 });
        assertSameSet(`${what} file`, { [diskLabel]: diskSet(dir, ext), [`cursor-stack.sh ${shBlock.replace(/[=(]+$/, '')}`]: sh });
        arrayCounts[what] = sh.size;
    }

    // 6. README headline counts equal the manifest/array sizes.
    const readmeText = fs.readFileSync(README, 'utf8');
    const readmeCount = rowLabel =>
    {
        // '| **Skills** (64) |' or '| **Skills** | 64 |'.
        const m = readmeText.match(new RegExp(`\\*\\*${rowLabel}[^*]*\\*\\*\\s*(?:\\((\\d+)\\)|\\|\\s*(\\d+))`));
        if (!m)
        {
            flag(`README.md: no headline '${rowLabel}' count found to verify against the manifests`);
            return null;
        }

        return Number(m[1] ?? m[2]);
    };

    for (const [rowLabel, expected] of [
        ['Skills', primary.active.size],
        ['MCP servers', mcpsPrimary.active.size],
        ['Hooks', arrayCounts.hook],
        ['Rules', arrayCounts.rule],
        ['Agents', arrayCounts.agent],
    ])
    {
        const got = readmeCount(rowLabel);
        if (got !== null && got !== expected)
        {
            flag(`README.md: headline ${rowLabel} count is ${got} but the installer holds ${expected}`);
        }
    }

    // 7. cursor-stack.html agrees with the manifests.
    const html = fs.readFileSync(STACK_HTML, 'utf8');

    // 7a. Personal rows == the active envoydev/cursor-stack entries (check 8
    //     proves those same entries equal the on-disk skills/ dirs).
    const htmlPersonal = new Set([...(html.split('const personal = {')[1] ?? '').split('};')[0]
        .matchAll(/\["([a-z0-9-]+)","/g)].map(m => m[1]));
    const personalManifest = new Set([...primary.active.keys()]
        .filter(s => primary.active.get(s) === 'envoydev/cursor-stack'));
    assertSameSet('personal skill', {
        'SKILLS manifest (envoydev/cursor-stack)': personalManifest,
        'cursor-stack.html personal': htmlPersonal,
    });

    // 7b. Repository rows == the third-party + commented inventory.
    const htmlRepo = new Set([...(html.split('const repository = [')[1] ?? '').split('\n];')[0]
        .matchAll(/\["([a-zA-Z0-9:_-]+)","/g)].map(m => m[1]));
    const thirdPartyActive = new Set([...primary.active.keys()].filter(s => primary.active.get(s) !== 'envoydev/cursor-stack'));
    const inventory = new Set([...thirdPartyActive, ...primary.commented.keys()]);
    for (const name of thirdPartyActive)
    {
        if (!htmlRepo.has(name))
        {
            flag(`manifest skill '${name}' is missing from the cursor-stack.html repository section`);
        }
    }

    for (const name of htmlRepo)
    {
        if (!inventory.has(name))
        {
            flag(`cursor-stack.html repository row '${name}' is not in the installer manifests (active or commented)`);
        }
    }

    // 7c. hooksRules rows == the CURSOR_HOOKS + CURSOR_RULES arrays.
    const htmlHooksRules = new Set([...(html.split('const hooksRules = [')[1] ?? '').split('\n];')[0]
        .matchAll(/\["([a-z0-9.-]+)","/g)].map(m => m[1]));
    const hooksRulesManifest = new Set([
        ...parseStringArray(CURSOR_SH, '"', 'CURSOR_HOOKS=('),
        ...parseStringArray(CURSOR_SH, '"', 'CURSOR_RULES=('),
    ]);
    assertSameSet('hook/rule row', {
        'installer HOOKS+RULES': hooksRulesManifest,
        'cursor-stack.html hooksRules': htmlHooksRules,
    });

    // 7d. Agent rows == CURSOR_AGENTS (names stripped of .md).
    const htmlAgents = new Set([...(html.split('const agents = [')[1] ?? '').split('\n];')[0]
        .matchAll(/\["([a-z0-9-]+)", "/g)].map(m => m[1]));
    const agentManifest = new Set(parseStringArray(CURSOR_SH, '"', 'CURSOR_AGENTS=(').map(a => a.replace(/\.md$/, '')));
    assertSameSet('agent row', {
        'installer CURSOR_AGENTS': agentManifest,
        'cursor-stack.html agents': htmlAgents,
    });

    // 8. The vendored skills/ dirs equal the active envoydev/cursor-stack
    //    manifest entries. The installer clones THIS repo and copies skills/,
    //    so a manifest entry with no dir silently installs nothing, and a dir
    //    with no entry is dead weight nothing ever copies. Each dir must also
    //    carry the SKILL.md the Cursor skill contract requires.
    const skillDirs = new Set(fs.existsSync(SKILLS_DIR)
        ? fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
        : []);
    assertSameSet('skill dir', {
        'SKILLS manifest (envoydev/cursor-stack)': personalManifest,
        'skills/': skillDirs,
    });

    for (const dir of skillDirs)
    {
        const skillMd = path.join(SKILLS_DIR, dir, 'SKILL.md');
        if (!fs.existsSync(skillMd))
        {
            flag(`skills/${dir} has no SKILL.md - Cursor will not load it as a skill`);
            continue;
        }

        // 8b. The frontmatter must load, or Cursor drops the skill silently.
        const { error, fields } = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
        if (error)
        {
            flag(`skills/${dir}/SKILL.md frontmatter: ${error}`);
            continue;
        }

        if (fields.name !== dir)
        {
            flag(`skills/${dir}/SKILL.md declares name '${fields.name ?? '(none)'}' - Cursor requires it to match the folder`);
        }

        if (!fields.description)
        {
            flag(`skills/${dir}/SKILL.md has no description - it is the routing key the agent matches on`);
        }

        for (const key of Object.keys(fields))
        {
            if (!SKILL_FIELDS.has(key))
            {
                flag(`skills/${dir}/SKILL.md carries '${key}:' - not in Cursor's SKILL.md schema (${[...SKILL_FIELDS].join(' / ')}), so it never fires`);
            }
        }

        if ('disable-model-invocation' in fields && !['true', 'false'].includes(fields['disable-model-invocation']))
        {
            flag(`skills/${dir}/SKILL.md: disable-model-invocation must be true or false, got '${fields['disable-model-invocation']}'`);
        }
    }

    // 9. Backticked hyphenated tokens in skills/**/*.md, agents/*.md,
    //    rules/*.mdc, and AGENTS.template.md resolve to a known skill (any
    //    manifest entry, active or commented), an MCP, an agent name, or the
    //    allowlist. The skills cross-reference each other constantly, so a
    //    rename here rots silently without this. Same case-collision rule: a
    //    capitalized token is a finding only when it case-insensitively
    //    collides with a known name.
    const resolvable = new Set([...primary.active.keys(), ...primary.commented.keys()]);
    for (const s of [...mcpsPrimary.active, ...mcpsPrimary.commented]) resolvable.add(s);
    for (const a of agentManifest) resolvable.add(a);
    const resolvableLower = new Map([...resolvable].map(k => [k.toLowerCase(), k]));

    const scanFiles = [TEMPLATE];
    for (const f of diskSet(AGENTS_DIR, '.md')) scanFiles.push(path.join(AGENTS_DIR, f));
    for (const f of diskSet(RULES_DIR, '.mdc')) scanFiles.push(path.join(RULES_DIR, f));
    const walkMarkdown = dir =>
    {
        for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
        {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walkMarkdown(full);
            else if (e.name.endsWith('.md')) scanFiles.push(full);
        }
    };
    walkMarkdown(SKILLS_DIR);
    for (const file of scanFiles.filter(fs.existsSync))
    {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)`/g))
        {
            const token = m[1];
            if (NON_SKILL_TOKENS.has(token) || resolvable.has(token))
            {
                continue;
            }

            const collision = resolvableLower.get(token.toLowerCase());
            if (token === token.toLowerCase())
            {
                flag(`${path.relative(ROOT, file)} references \`${token}\` - not a known skill/MCP/agent (typo? add to NON_SKILL_TOKENS if intentional)`);
            }
            else if (collision)
            {
                flag(`${path.relative(ROOT, file)} references \`${token}\` - wrong casing for '${collision}'`);
            }
        }
    }

    // 10. No peer-stack framing on any surface that reaches a consuming project
    //     or a reader. The skills and agents share ancestry with the peer repo,
    //     so a ported fix can drag its framing back in ('twin of X', 'X-only',
    //     a .claude/ path); this is the guard that keeps the port honest. Two
    //     exceptions are real and allowed: the ${CLAUDE_PROJECT_DIR} /
    //     ${CLAUDE_CONFIG_DIR} MCPS path tokens (mechanism - resolved to
    //     concrete paths before .cursor/mcp.json is written, never seen by a
    //     user), and CLAUDE.md as a bare filename (a real file in sibling repos
    //     the template tells an agent to read). This file and the repo's own
    //     CLAUDE.md are not scanned: one is the enforcement, the other is the
    //     documented exception.
    const framingFiles = [README, STACK_HTML, TEMPLATE];
    // Every shell script in scripts/ - discovered, not named, so a script added later is
    // covered without anyone remembering to list it here. This deliberately picks up the two
    // installer twins plus standalone utilities (fix-serena-ts-windows.ps1). lint-stack.js
    // itself is .js and so excluded by construction: it IS the enforcement and quotes the
    // very tokens it bans.
    for (const ext of ['.sh', '.ps1'])
    {
        for (const f of diskSet(SCRIPTS_DIR, ext)) framingFiles.push(path.join(SCRIPTS_DIR, f));
    }

    for (const [dir, ext] of [[AGENTS_DIR, '.md'], [RULES_DIR, '.mdc'], [HOOKS_DIR, '.js']])
    {
        for (const f of diskSet(dir, ext)) framingFiles.push(path.join(dir, f));
    }

    const skillFiles = [];
    const walkAll = dir =>
    {
        for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
        {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walkAll(full);
            else skillFiles.push(full);
        }
    };
    walkAll(SKILLS_DIR);

    const ALLOWED = /CLAUDE_PROJECT_DIR|CLAUDE_CONFIG_DIR|CLAUDE\.md/g;
    for (const file of [...framingFiles, ...skillFiles].filter(fs.existsSync))
    {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++)
        {
            const stripped = lines[i].replace(ALLOWED, '');
            const hit = stripped.match(/claude/i);
            if (hit)
            {
                flag(`${path.relative(ROOT, file)}:${i + 1} names '${hit[0]}' - this repo's surfaces describe Cursor on its own terms (see CLAUDE.md); allowed only as the ${'${CLAUDE_PROJECT_DIR}'} / ${'${CLAUDE_CONFIG_DIR}'} tokens or the CLAUDE.md filename`);
            }
        }
    }

    // 11. House dotnet-* skills are original work, not vendored copies - no
    //    'Vendored from' label on a dotnet-* HTML line.
    const provenance = /\bvendored from\b/i;
    for (const line of html.split('\n'))
    {
        if (/dotnet-/.test(line) && provenance.test(line))
        {
            flag(`cursor-stack.html has a dotnet-* line with a 'Vendored from' label - house dotnet-* skills are original work`);
        }
    }

    if (findings.length > 0)
    {
        for (const finding of findings)
        {
            console.error(`LINT: ${finding}`);
        }

        console.error(`\n${findings.length} finding(s).`);
        process.exit(1);
    }

    console.log(`lint-stack: clean (${primary.active.size} active skill entries == ${skillDirs.size} vendored skills/ dirs, ${mcpsPrimary.active.size} MCPs, `
        + `${arrayCounts.agent} agents + ${arrayCounts.rule} rules + ${arrayCounts.hook} hooks on disk == manifests; `
        + `.sh/.ps1 twins + HTML in sync).`);
}

module.exports = {
    paths: { ROOT, CURSOR_SH, CURSOR_PS1, AGENTS_DIR, RULES_DIR, HOOKS_DIR },
    parseManifest,
    parseStringArray,
    parseFlatBlock,
    NON_SKILL_TOKENS,
};

if (require.main === module)
{
    main();
}
