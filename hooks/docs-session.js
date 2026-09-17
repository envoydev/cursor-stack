#!/usr/bin/env node
// docs-session.js - makes the architecture docs the starting point of a session and keeps them honest at its end.
// Adapted from claude-stack's stack/hooks/docs-session.js for Cursor's hook contract (cursor.com/docs/hooks) -
// event names, payload fields and output shapes are Cursor's; docs.js (the engine it requires) is unchanged.
//   sessionStart -> folds merged branches' doc versions into mainline, then pushes ORIENTATION.md, this branch's
//                   overrides and conflicts, and how to read by section; snapshots the tree for the end check.
//                   Output: { additional_context }.
//   preToolUse   -> records reads of the docs; holds the FIRST change under a source root until a section was
//                   read, handing the covering section over inline. Wired UNSCOPED (this installer's
//                   hooks.json generator has no per-entry matcher, the same way guard-secret-value.js is
//                   wired) - the tool_name check below does the filtering. Output: { permission, agent_message }.
//   stop         -> once per session: a change that hit watch.json asks for the owning sections to be
//                   rewritten when a rule moved, or confirmed. Output: { followup_message } - Cursor's stop
//                   cannot block, so this is a nudge rather than a hard gate.
// NOT SHIPPED: the subagentStart orientation. Cursor's subagentStart can only answer { permission,
// user_message } - it has no channel to inject context - so a dispatched subagent never sees this hook's
// orientation, unlike the main session (see project-architecture-analyzer/references/doc-shapes.md's
// ORIENTATION.md section, which says so).
// CURSOR_DOCS_BLOCK=0 / CURSOR_DOCS_GATE=0 / CURSOR_DOCS_ASK=0 turn the three parts off.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const docsRootEnv = () => process.env.CURSOR_DOCS_PATH || '.cursor/docs';
const MAX_HOLDS = 2;
const INLINE_CHARS = 3000;
const ASK_SECTIONS = 3;
const READ = 'node .cursor/hooks/docs.js';

const readInput = () => { try { const v = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
// Cursor's stable id is session_id at sessionStart, conversation_id at every later event (generation_id
// changes with every user message, so it is the wrong key for session state).
const sessionKey = (input) => input.session_id || input.conversation_id || 'none';
const statePath = (s) => path.join(os.tmpdir(), `docs-session-${String(s || 'none').replace(/[^\w-]/g, '')}.json`);
const loadState = (s) => { let v = {}; try { v = JSON.parse(fs.readFileSync(statePath(s), 'utf8')); } catch {} return { consults: [], holds: 0, edits: 0, asked: false, snapshot: null, ...v }; };
const saveState = (s, v) => { try { fs.writeFileSync(statePath(s), JSON.stringify(v)); } catch {} };
const emit = (text) => process.stdout.write(JSON.stringify({ additional_context: text }));
const allow = () => process.stdout.write(JSON.stringify({ permission: 'allow' }));
// The same file docs.js's own CLI logger writes (.claude/docs-log.jsonl - unchanged there too, since the
// engine stays byte-identical with claude-stack): one ledger for both surfaces, never split per platform.
const log = (root, row) => { try { fs.appendFileSync(path.join(root, '.claude', 'docs-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`); } catch {} };

function orientation(root, docs) {
  let block = '';
  try { block = fs.readFileSync(docs.BLOCK_FILE, 'utf8').trim(); } catch {}
  return [
    'How this project is documented - read this before deciding how to implement anything.',
    ...(block ? ['', block] : []),
    '',
    `The docs live under \`${path.relative(root, docs.DOCS).split(path.sep).join('/')}/\`. Read them by section, not whole files:`,
    `\`${READ} where <path>\` names the sections covering a file; \`${READ} show <file>#<id>\` prints one.`,
    'For a specific symbol the CODE wins; the docs give the decisions, the conventions and the reasons.',
  ];
}

function sessionStart(input, root, docs, state) {
  if (!state.snapshot) { try { state.snapshot = docs.snapshot(); } catch {} saveState(sessionKey(input), state); }
  let promoted = [];
  try { promoted = docs.autoPromote(); } catch {}
  // A row with changed=false is a standing, already-reported conflict - skip it, or it would be re-logged and
  // re-announced at every session start.
  const landed = promoted.filter((p) => p.changed);
  for (const p of landed) log(root, { event: 'promote', branch: p.branch, how: p.how, results: p.results });
  try { docs.refreshBaseMeta(); } catch {}
  if (process.env.CURSOR_DOCS_BLOCK === '0') return;
  let st = null;
  try { st = docs.status(); } catch {}
  const lines = orientation(root, docs);
  const extra = [];
  for (const p of landed) {
    const ok = p.results.filter((x) => x.result !== 'conflict');
    const bad = p.results.filter((x) => x.result === 'conflict');
    extra.push(`Branch ${p.branch} was merged: ${ok.length} doc section(s) folded into mainline.${bad.length ? ` To reconcile: ${bad.map((x) => `${x.id} (\`${READ} show ${x.id} --conflict ${p.branch}\`, then \`${READ} set ${x.id}\`)`).join(', ')}.` : ''}`);
  }
  if (st && st.detached) extra.push('Detached HEAD: the docs are read-only until a branch is checked out.');
  // After a git merge of committed docs, or a hand edit: the two breakages that make a doc untrustworthy to read.
  let broken = [];
  try { broken = docs.lint().problems.filter((p) => /^(merge conflict markers|duplicate id)/.test(p)); } catch {}
  if (broken.length) extra.push(`The docs need a repair before they are trusted: ${broken.slice(0, 3).join('; ')}${broken.length > 3 ? ` (+${broken.length - 3} more: \`${READ} lint\`)` : ''}.`);
  if (st && st.overrides.length) extra.push(`You are on branch ${st.branch}. ${st.overrides.length} doc section(s) hold this branch's own decisions and replace mainline's in every read: ${st.overrides.slice(0, 6).join(', ')}${st.overrides.length > 6 ? ` ... (\`${READ} status\`)` : ''}.`);
  if (st && st.conflicts.length) extra.push(`Conflicts: ${st.conflicts.join(', ')} - mainline changed lines this branch also changed; \`${READ} show <id> --conflict\` shows both, \`${READ} set <id>\` saves the reconciled text.`);
  if (st && st.mainline && st.deletedUnmerged.length) extra.push(`Doc versions of deleted branches never detected as merged: ${st.deletedUnmerged.join(', ')} - \`${READ} promote <branch>\` folds one in, \`${READ} prune <branch>\` drops it.`);
  if (st && st.outgrown) extra.push(`${st.outgrown} section(s) describe code that changed since they were written - each says so when opened, and the code wins there.`);
  if (process.env.CURSOR_DOCS_GATE !== '0') {
    let roots = ['src', 'tests'];
    try { roots = docs.loadWatch().sourceRoots; } catch {}
    extra.push(`Before your first change under ${roots.map((x) => `${x}/`).join(' or ')}, read the section covering the file.`);
  }
  emit([...lines, ...(extra.length ? ['', ...extra] : [])].join('\n'));
}

function main() {
  const input = readInput();
  const event = input.hook_event_name;
  if (!event) return;
  const root = (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || input.cwd || process.cwd();
  // Bridge the resolved project root into the engine: docs.js reads CLAUDE_PROJECT_DIR unconditionally
  // and has no Cursor-named equivalent for it, because a hook process's own cwd is not reliably the
  // project root the way a model-run shell command's is. The docs ROOT PATH needs no such bridge: this
  // Cursor copy of docs.js (second permitted difference from the byte-identical engine, alongside the
  // conflictView hint text - see the Task 12 report's engine-parity section) reads CURSOR_DOCS_PATH
  // itself, so it resolves the same docs folder whether it is required here or run directly by the
  // model from its own shell, which never goes through this process's env at all.
  process.env.CLAUDE_PROJECT_DIR = root;
  const docs = require('./docs.js');
  if (!fs.existsSync(docs.DOCS)) { if (event === 'preToolUse') allow(); return; }
  const state = loadState(sessionKey(input));
  if (event === 'sessionStart') return sessionStart(input, root, docs, state);
  if (event === 'preToolUse') return preToolUse(input, root, docs, state);
  if (event === 'stop') return stop(input, root, docs, state);
}

// What the tool is about to touch, project-relative.
function toolPaths(input, root) {
  const t = input.tool_input || {};
  const out = [];
  for (const p of [t.file_path, t.path, t.relative_path, t.notebook_path]) if (typeof p === 'string' && p) out.push(p);
  if (typeof t.command === 'string') {
    for (const w of t.command.split(/[\s;|&<>()'"`]+/)) {
      if (/[\w.-]\/[\w.-]/.test(w)) out.push(w.replace(/^[^\w./~-]+|[,:]+$/g, '').replace(/:\d+(:\d+)?$/, ''));
    }
  }
  return [...new Set(out.map((p) => path.relative(root, path.resolve(root, p))).filter((p) => p && !p.startsWith('..')))];
}

// The paths a shell command WRITES, not every path it mentions: redirect targets (never /dev/null or a file
// descriptor), tee arguments, files edited in place by sed/perl, cp/mv destinations, rm/mkdir/touch arguments, and the
// project a migration or a patch lands in. `grep -n X src/... 2>/dev/null` writes nothing, and neither does
// `dotnet test tests/Api > run.log`. A write whose target cannot be named counts as a write under the first source root.
const UNKNOWN_SOURCE_WRITE = '<unknown source write>';
function writeTargets(command) {
  let c = String(command);
  // A heredoc body is content, not shell: `x => y` inside it is no redirect.
  c = c.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (m) => m.split('\n')[0]);
  // Quoted text is an argument, not syntax - kept only as a redirect target.
  c = c.replace(/(>>?\s*)?(["'])((?:(?!\2)[^\\]|\\.)*)\2/g, (m, redirect, q, body) => (redirect ? `${redirect}${body.replace(/\s/g, '_')}` : 'QUOTED'));
  const out = [];
  for (const m of c.matchAll(/(?:^|[^\w&<>=-])(?:\d|&)?>>?\|?\s*([^\s;|&<>()]+)/g)) if (m[1] !== '/dev/null' && !/^&/.test(m[1])) out.push(m[1]);
  for (const simple of c.split(/&&|\|\||[;|\n]/)) {
    const words = simple.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^\w+=/.test(words[0]) || /^(sudo|env|nohup|time|command|xargs)$/.test(words[0]))) words.shift();
    const [cmd, ...rest] = words;
    const args = rest.filter((w) => !w.startsWith('-') && !/^\d?>|^</.test(w));
    if (!cmd) continue;
    if (cmd === 'tee') out.push(...args);
    else if (cmd === 'sed' && rest.some((w) => /^-[a-zA-Z]*i/.test(w) || w === '--in-place')) out.push(...args.filter((w) => w !== 'QUOTED' && !/^s\W/.test(w)));
    else if (cmd === 'perl' && rest.some((w) => /^-[a-zA-Z]*i/.test(w))) out.push(...args.filter((w) => w !== 'QUOTED'));
    else if (/^(cp|mv|install|ln|rsync)$/.test(cmd)) { const t = rest.indexOf('-t'); out.push(t >= 0 && rest[t + 1] ? rest[t + 1] : args[args.length - 1]); }
    else if (/^(rm|rmdir|mkdir|touch|truncate)$/.test(cmd)) out.push(...args);
    else if (cmd === 'chmod') out.push(...args.slice(1));
    else if (cmd === 'dd') out.push(...rest.filter((w) => w.startsWith('of=')).map((w) => w.slice(3)));
    else if (cmd === 'dotnet' && rest[0] === 'new') { const o = rest.findIndex((w) => w === '-o' || w === '--output'); out.push(o >= 0 && rest[o + 1] ? rest[o + 1] : UNKNOWN_SOURCE_WRITE); }
    else if (cmd === 'dotnet' && rest[0] === 'ef' && rest[1] === 'migrations' && /^(add|remove)$/.test(rest[2] || '')) { const o = rest.findIndex((w) => w === '-p' || w === '--project'); out.push(o >= 0 && rest[o + 1] ? rest[o + 1] : UNKNOWN_SOURCE_WRITE); }
    else if (cmd === 'git' && rest[0] === 'apply') out.push(UNKNOWN_SOURCE_WRITE);
    else if (cmd === 'git' && (rest[0] === 'restore' || (rest[0] === 'checkout' && rest.includes('--')))) out.push(...rest.slice(rest.includes('--') ? rest.indexOf('--') + 1 : 1).filter((w) => !w.startsWith('-')));
  }
  return [...new Set(out.filter((t) => t && t !== 'QUOTED'))];
}
const relative = (root, paths) => [...new Set(paths.map((p) => path.relative(root, path.resolve(root, p.replace(/^['"]|['"]$/g, '')))).filter((p) => p && !p.startsWith('..')))];

// Only reading a section's text is a consult: `where`, `toc` and listings point at sections without reading them.
function consultedBy(input, paths, docsRel) {
  const name = input.tool_name || '';
  const t = input.tool_input || {};
  const command = typeof t.command === 'string' ? t.command : '';
  if (/docs\.js[ \t]+show[ \t]/.test(command)) {
    return (command.match(/docs\.js[ \t]+show[ \t]+[\w#.\/-]+(?:[ \t]+[\w#.\/-]+)*/g) || [])
      .flatMap((r) => r.split(/[ \t]+/).slice(2))
      .filter((r) => !r.startsWith('-') && /^[A-Za-z][\w.\/-]*(#[\w-]+)?$/.test(r));
  }
  if (/docs\.js[ \t]+(toc|where|files|status|lint|watch|stale)\b/.test(command)) return [];
  const isDoc = (p) => p === docsRel || p.startsWith(`${docsRel}/`);
  const hits = paths.filter(isDoc);
  if (hits.length && (/^(Read|Grep)$/.test(name) || (name === 'Shell' && !writeTargets(command).length))) return hits;
  return [];
}

function blockRow(root, input, reason) {
  try {
    const dir = path.resolve(root, docsRootEnv(), 'hook-blocks');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${sessionKey(input) || 'nosession'}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), hook: 'docs-session.js', event: input.hook_event_name || '', tool: input.tool_name || '', reason: String(reason).split('\n')[0].slice(0, 200) })}\n`);
  } catch {}
}

function preToolUse(input, root, docs, state) {
  const name = input.tool_name || '';
  // Wired unscoped (this installer's hooks.json generator carries no per-entry matcher, the same way
  // guard-secret-value.js's preToolUse wiring works) - filter to the relevant tools here instead.
  if (!/^(Read|Write|Grep|Shell)$/.test(name)) return allow();
  const paths = toolPaths(input, root);
  const docsRel = path.relative(root, docs.DOCS).split(path.sep).join('/');
  const consults = consultedBy(input, paths, docsRel);
  if (consults.length) {
    state.consults.push(...consults);
    saveState(sessionKey(input), state);
    log(root, { event: 'consult', refs: consults.slice(0, 5), tool: name });
    return allow();
  }
  // Only these two tools can name a source WRITE target (no Edit/MultiEdit/NotebookEdit in Cursor - Write
  // covers an edit too), so nothing else pays for the watch list.
  if (!/^(Write|Shell)$/.test(name)) return allow();
  let roots = ['src', 'tests'];
  try { roots = docs.loadWatch().sourceRoots; } catch {}
  const inRoots = (p) => roots.some((x) => p === x || p.startsWith(`${x}/`));
  const command = typeof (input.tool_input || {}).command === 'string' ? input.tool_input.command : '';
  let targets = [];
  if (name === 'Write') targets = paths.filter(inRoots);
  else if (name === 'Shell') targets = relative(root, writeTargets(command).map((x) => (x === UNKNOWN_SOURCE_WRITE ? `${roots[0]}/*` : x))).filter(inRoots);
  if (!targets.length) return allow();
  const proceed = () => {
    state.edits++;
    saveState(sessionKey(input), state);
    if (state.edits === 1) log(root, { event: 'first-edit', target: targets[0], consulted: state.consults.length > 0 });
    return allow();
  };
  if (process.env.CURSOR_DOCS_GATE === '0' || state.consults.length) return proceed();
  if (state.holds >= MAX_HOLDS) { log(root, { event: 'bypass', target: targets[0], holds: state.holds }); return proceed(); }
  state.holds++;
  saveState(sessionKey(input), state);
  let hits = [];
  try { hits = docs.where(targets, 3); } catch {}
  let reason;
  if (!hits.length) {
    reason = `Architecture docs not read yet in this session. Before changing ${targets[0]}, see what is documented: ${READ} files`;
  } else {
    const [first, ...rest] = hits;
    const body = first.text.length > INLINE_CHARS ? `${first.text.slice(0, INLINE_CHARS)}\n... (${first.text.length - INLINE_CHARS} more chars: \`${READ} show ${first.id}\`)` : first.text;
    state.consults.push(first.id);
    saveState(sessionKey(input), state);
    log(root, { event: 'consult', refs: [first.id], tool: 'gate-inline' });
    reason = [
      `Architecture docs not read yet in this session. ${first.id} covers ${targets[0]} - here it is:`,
      '', body, '',
      ...(rest.length ? [`Also covering it: ${rest.map((h) => `${h.id} (${h.chars} chars, \`${READ} show ${h.id}\`)`).join(', ')}`, ''] : []),
      'That is the convention this change follows. Now make the change.',
    ].join('\n');
  }
  log(root, { event: 'hold', target: targets[0], offered: hits.map((h) => h.id) });
  blockRow(root, input, reason);
  process.stdout.write(JSON.stringify({ permission: 'deny', agent_message: reason }));
}

function stop(input, root, docs, state) {
  if (process.env.CURSOR_DOCS_ASK === '0' || state.asked || !state.snapshot) return;
  let changed;
  let hits = [];
  try {
    changed = docs.changedSince(state.snapshot);
    if (!changed.files.length && !changed.dirs.length) return;
    hits = docs.watchHits(changed.files, changed.dirs);
  } catch { return; }
  if (!hits.length) return;
  const ids = [...new Set(hits.flatMap((h) => h.sections))].slice(0, ASK_SECTIONS);
  const files = [...new Set(hits.flatMap((h) => h.files))];
  const kinds = [...new Set(hits.map((h) => h.kind))];
  state.asked = true;
  saveState(sessionKey(input), state);
  log(root, { event: 'ask-update', sections: ids, files: files.slice(0, 5), kinds });
  let scope = 'It is written into the doc file itself.';
  try {
    const st = docs.status();
    if (st.mode.startsWith('overlay') && !st.mainline) scope = `It is saved for branch ${st.branch} only; mainline keeps its own text until the branch merges.`;
  } catch {}
  const one = ids.length === 1;
  process.stdout.write(JSON.stringify({
    followup_message: [
      `One check before you finish. You changed ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''} (${kinds.join(', ')}), which ${one ? 'this section owns' : 'these sections own'}: ${ids.join(', ')}.`,
      `Open ${one ? 'it' : 'them'}: ${READ} show ${ids.join(' ')}`,
      'For each: if your change moved a rule, boundary, contract or pattern it states, rewrite that section - heading included, changing only what your change made untrue - and save it:',
      `  ${READ} set <file>#<id> <<'MD'`,
      '  <the whole section>',
      '  MD',
      `${scope} Leave out the captured line; set stamps it.`,
      `If ${one ? 'it still holds' : 'they still hold'}, reply 'docs still hold: ${ids.join(', ')}' and finish. Do not edit any other doc.`,
    ].join('\n'),
  }));
}

module.exports = { writeTargets, consultedBy, toolPaths };
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`docs-session: ${error.message}\n`); }
}
