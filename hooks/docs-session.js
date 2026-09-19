#!/usr/bin/env node
// docs-session.js - makes the project's docs (every domain under the docs root) the starting point of a session
// and keeps them honest at its end.
// Adapted from claude-stack's stack/hooks/docs-session.js for Cursor's hook contract (cursor.com/docs/hooks) -
// event names, payload fields and output shapes are Cursor's; docs.js (the engine it requires) is unchanged.
//   sessionStart -> folds merged branches' doc versions into mainline, then pushes ORIENTATION.md, this branch's
//                   overrides and conflicts, and how to read by section; snapshots the tree for the end check.
//                   Output: { additional_context }.
//   preToolUse   -> records reads of the docs; holds the FIRST change under a source root until a section was
//                   read, handing the covering section over inline - what a merge just folded into mainline
//                   comes first. Wired UNSCOPED (this installer's hooks.json generator has no per-entry
//                   matcher, the same way guard-secret-value.js is wired) - the tool_name check below does
//                   the filtering. Output: { permission, agent_message }.
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
// The same file docs.js's own CLI logger writes (<docs-path>/docs-log.jsonl, resolved by docsRootEnv() -
// the engine stays byte-identical with claude-stack, and both surfaces resolve the same Cursor-native
// root): one ledger for both surfaces, never split per platform. It lives under the docs root beside
// hook-blocks/, not under .claude/ - a Cursor project has no reason to grow that folder at all.
// One log file holds every session's rows, and two sessions interleave in it, so each row carries the id
// that tells them apart - sessionKey(), not input.session_id, since Cursor's own id lives under
// conversation_id outside sessionStart.
const log = (root, input, row) => {
  try {
    const dir = path.resolve(root, docsRootEnv());
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'docs-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), session: sessionKey(input), ...row })}\n`);
  } catch {}
};

function orientation(root, docs) {
  let block = '';
  try { block = fs.readFileSync(docs.BLOCK_FILE, 'utf8').trim(); } catch {}
  // ORIENTATION.md stays architecture's own file, read exactly as before - a domain gets no per-domain
  // twin. The docs-root line below used to name architecture/ as if it were the only docs folder; a
  // project whose docs are code-style/ and decisions/ (no architecture/ at all) is named correctly here.
  let doms = [];
  try { doms = docs.domains(); } catch {}
  const rootRel = path.relative(root, docs.DOCS_ROOT).split(path.sep).join('/');
  return [
    'How this project is documented - read this before deciding how to implement anything.',
    ...(block ? ['', block] : []),
    '',
    `The docs live under \`${rootRel}/\` (${doms.join(', ')}). Read them by section, not whole files:`,
    `\`${READ} where <path>\` names the sections covering a file; \`${READ} show <file>#<id>\` prints one.`,
    'For a specific symbol the CODE wins; the docs give the decisions, the conventions and the reasons.',
  ];
}

function sessionStart(input, root, docs, state) {
  if (!state.snapshot) { try { state.snapshot = docs.snapshot(); } catch {} saveState(sessionKey(input), state); }
  // Repair the branch snapshots BEFORE looking for merged branches, so a snapshot repaired here is
  // promotable in this session and not only the next one.
  try { docs.refreshBaseMeta(); } catch {}
  let promoted = [];
  try { promoted = docs.autoPromote(); } catch {}
  // A row with changed=false is a standing, already-reported conflict - skip it, or it would be re-logged and
  // re-announced at every session start.
  const landed = promoted.filter((p) => p.changed);
  for (const p of landed) log(root, input, { event: 'promote', branch: p.branch, how: p.how, results: p.results });
  if (process.env.CURSOR_DOCS_BLOCK === '0') return;
  let st = null;
  try { st = docs.status(); } catch {}
  const lines = orientation(root, docs);
  const extra = [];
  for (const p of landed) {
    const ok = p.results.filter((x) => x.result !== 'conflict');
    const bad = p.results.filter((x) => x.result === 'conflict');
    // The ids, the way the branch-override line beside it names its own: a count tells the session that something
    // it has not read just changed, and nothing about what to read. Six ids, then a count - the block is paid for
    // by every session.
    const names = ok.length ? ` and now hold its decisions: ${ok.slice(0, 6).map((x) => x.id).join(', ')}${ok.length > 6 ? ` (+${ok.length - 6} more)` : ''}` : '';
    extra.push(`Branch ${p.branch} was merged: ${ok.length} doc section(s) folded into mainline${names}.${bad.length ? ` To reconcile: ${bad.map((x) => `${x.id} (\`${READ} show ${x.id} --conflict ${p.branch}\`, then \`${READ} set ${x.id}\`)`).join(', ')}.` : ''}`);
  }
  if (st && st.detached) extra.push('Detached HEAD: the docs are read-only until a branch is checked out.');
  // The declared mode wins over what git does, so where the two disagree the session is told before it writes a doc:
  // one line, the engine's own wording, and nothing at all when nothing is declared or the two agree.
  if (st && st.mismatch) extra.push(st.mismatch);
  // Branch versions nothing can reach under git versioning. Only `docs.js status` knew, and nothing runs that by
  // itself - so a decision written under the overlay model sat unreadable and unmentioned, session after session.
  // Nothing sweeps them either - the 30-day sweep stands down under git versioning - so this line comes back every
  // session. It is a prompt only if it names the command that ends it, with the branch filled in; a placeholder
  // would make it a nag. The field is guarded like its neighbours: an older engine beside this hook returns a
  // status without it, and an unguarded read would throw away the whole block.
  if (st && st.stranded && st.stranded.length) extra.push(`Doc versions stranded by this install's git versioning: ${st.stranded.slice(0, 6).join(', ')}${st.stranded.length > 6 ? ` (+${st.stranded.length - 6} more)` : ''} - nothing reads or promotes .branches/ any more, and this line returns every session until they are gone: re-apply what is still wanted with \`${READ} set <file>#<id>\`, then end it with \`${READ} prune ${st.stranded[0]}\`${st.stranded.length > 1 ? ' (one prune per name)' : ''}.`);
  // After a git merge of committed docs, or a hand edit: the two breakages that make a doc untrustworthy to read.
  let broken = [];
  try { broken = docs.lint().problems.filter((p) => /^(merge conflict markers|duplicate id)/.test(p)); } catch {}
  if (broken.length) extra.push(`The docs need a repair before they are trusted: ${broken.slice(0, 3).join('; ')}${broken.length > 3 ? ` (+${broken.length - 3} more: \`${READ} lint\`)` : ''}.`);
  if (st && st.overrides.length) extra.push(`You are on branch ${st.branch}. ${st.overrides.length} doc section(s) hold this branch's own decisions and replace mainline's in every read: ${st.overrides.slice(0, 6).join(', ')}${st.overrides.length > 6 ? ` ... (\`${READ} status\`)` : ''}.`);
  if (st && st.conflicts.length) extra.push(`Conflicts: ${st.conflicts.join(', ')} - mainline changed lines this branch also changed; \`${READ} show <id> --conflict\` shows both, \`${READ} set <id>\` saves the reconciled text.`);
  if (st && st.mainline && st.deletedUnmerged.length) extra.push(`Doc versions of deleted branches never detected as merged: ${st.deletedUnmerged.join(', ')} - \`${READ} promote <branch>\` folds one in, \`${READ} prune <branch>\` drops it.`);
  if (st && st.mainline && st.liveOnMainline && st.liveOnMainline.length) extra.push(`Doc versions of branches sitting on mainline with no proof they merged: ${st.liveOnMainline.join(', ')} - one that was merged fast-forward looks exactly like one that only caught up, so nothing was folded in; if it landed, \`${READ} promote <branch>\`.`);
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
  // A domain is any top-level folder under the docs root holding a watch.json (architecture counts even
  // without one - see docs.js's own domains()). A project whose docs are code-style/ and decisions/,
  // with no architecture/ at all, must still get the SessionStart block, the gate and the finish ask - so
  // the whole-hook gate reads every domain, not one hardcoded folder. An empty list is still the right
  // reason to return: nothing under the docs root declares itself a domain.
  if (!docs.domains().length) { if (event === 'preToolUse') allow(); return; }
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
  return [...new Set(out.map((p) => path.relative(root, path.resolve(root, p)).split(path.sep).join('/')).filter((p) => p && !p.startsWith('..')))];
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
// Always '/'-separated: every consumer (the watch roots, the covers globs, the log) is written with '/', and
// path.relative answers with '\' on Windows, where a native separator here silently disarmed the gate.
const relative = (root, paths) => [...new Set(paths.map((p) => path.relative(root, path.resolve(root, p.replace(/^['"]|['"]$/g, ''))).split(path.sep).join('/')).filter((p) => p && !p.startsWith('..')))];

// Only reading a section's text is a consult: `where`, `toc` and listings point at sections without reading them.
// `docRoots` is a LIST now, one entry per domain (each domain's own root, project-relative) - a project can be
// documented in code-style/ or decisions/ alone, and a read under any one of them is a real consult, not just
// one under architecture/. Deliberately NOT the whole docs root: DOCS_ROOT also holds hook-blocks/,
// docs-log.jsonl and .branches/, none of which is a section covering a file.
function consultedBy(input, paths, docRoots) {
  const name = input.tool_name || '';
  const t = input.tool_input || {};
  const command = typeof t.command === 'string' ? t.command : '';
  if (/docs\.js[ \t]+show[ \t]/.test(command)) {
    return (command.match(/docs\.js[ \t]+show[ \t]+[\w#.\/-]+(?:[ \t]+[\w#.\/-]+)*/g) || [])
      .flatMap((r) => r.split(/[ \t]+/).slice(2))
      .filter((r) => !r.startsWith('-') && /^[A-Za-z][\w.\/-]*(#[\w-]+)?$/.test(r));
  }
  if (/docs\.js[ \t]+(toc|where|files|status|lint|watch|stale)\b/.test(command)) return [];
  const isDoc = (p) => docRoots.some((d) => p === d || p.startsWith(`${d}/`));
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
  // One root per domain, not one hardcoded architecture/ - a project documented only in code-style/ must
  // still get credit for reading it. domains() is already required to succeed for this hook to have run
  // at all (see main()'s own gate above), so no extra guard is needed here.
  const docRoots = docs.domains().map((d) => path.relative(root, docs.domainDir(d)).split(path.sep).join('/'));
  const consults = consultedBy(input, paths, docRoots);
  if (consults.length) {
    state.consults.push(...consults);
    saveState(sessionKey(input), state);
    log(root, input, { event: 'consult', refs: consults.slice(0, 5), tool: name });
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
    if (state.edits === 1) log(root, input, { event: 'first-edit', target: targets[0], consulted: state.consults.length > 0 });
    return allow();
  };
  if (process.env.CURSOR_DOCS_GATE === '0' || state.consults.length) return proceed();
  if (state.holds >= MAX_HOLDS) { log(root, input, { event: 'bypass', target: targets[0], holds: state.holds }); return proceed(); }
  state.holds++;
  saveState(sessionKey(input), state);
  let hits = [];
  try { hits = docs.where(targets, 3); } catch {}
  let reason;
  if (!hits.length) {
    reason = `Docs not read yet in this session. Before changing ${targets[0]}, see what is documented: ${READ} files`;
  } else {
    const [first, ...rest] = hits;
    const body = first.text.length > INLINE_CHARS ? `${first.text.slice(0, INLINE_CHARS)}\n... (${first.text.length - INLINE_CHARS} more chars: \`${READ} show ${first.id}\`)` : first.text;
    state.consults.push(first.id);
    saveState(sessionKey(input), state);
    log(root, input, { event: 'consult', refs: [first.id], tool: 'gate-inline' });
    reason = [
      `Docs not read yet in this session. ${first.id} covers ${targets[0]} - here it is:`,
      '', body, '',
      ...(rest.length ? [`Also covering it: ${rest.map((h) => `${h.id} (${h.chars} chars, \`${READ} show ${h.id}\`)`).join(', ')}`, ''] : []),
      'That is the convention this change follows. Now make the change.',
    ].join('\n');
  }
  log(root, input, { event: 'hold', target: targets[0], offered: hits.map((h) => h.id) });
  blockRow(root, input, reason);
  process.stdout.write(JSON.stringify({ permission: 'deny', agent_message: reason }));
}

// A watch.json entry's sections are stored verbatim, and watchHits tags every hit with the domain it came
// from. docs.protectedRef is tried first, scoped to the hit's OWN domain: a domain's own notOwned file
// drops out of domainFiles entirely, so a bare id naming it would otherwise resolve to nothing (or, if
// another domain holds a same-named file, silently to the WRONG domain's copy) instead of being recognised
// as a decision a person owns. Two lists, capped separately: an ask offers a rewrite, a warning offers
// none, and they must never compete for the same slot.
// An ask goes into the answer as `docs.js show <ref>`, so the ref it carries has to be one the engine can
// actually resolve. A watch entry's sections are stored VERBATIM, and the bare 'patterns#orders' that every
// watch.json written before domains existed holds turns ambiguous the moment a second domain owns a
// references/patterns.md of its own - which is ordinary, since every domain owns a references/ folder.
// parseRef then refuses ('patterns#orders is in architecture and code-style - name one'), and the ask hands
// the user a command that cannot work. The entry's own domain is what disambiguates it, exactly as it does
// at lint. The BARE spelling is preferred so an unambiguous entry keeps printing the short form it prints
// today; the domain-qualified one is the fallback, and an id neither spelling resolves is passed through
// unchanged (there is nothing better to say, and the ask still names the section the watch entry named).
// Guarded like docs.protectedRef above: an older docs.js copy beside this hook exports no findSection, and
// the safe degradation there is the verbatim id this hook has always emitted, never a throw.
const askRefOf = (docs, domain, id) => {
  try {
    if (typeof docs.findSection !== 'function') return id;
    if (docs.findSection(id)) return id;
    const qualified = `${domain}/${id}`;
    return docs.findSection(qualified) ? qualified : id;
  } catch { return id; }
};

function splitHits(docs, hits, limit) {
  const seenAsk = new Set();
  const seenWarn = new Set();
  const asks = [];
  const warnings = [];
  for (const h of hits) {
    for (const id of h.sections) {
      let warn = null;
      try { warn = docs.protectedRef(h.domain, id); } catch {}
      if (warn) {
        if (warnings.length < limit && !seenWarn.has(warn.id)) { seenWarn.add(warn.id); warnings.push(warn); }
        continue;
      }
      // Deduped on the RESOLVED ref, not the stored one: two entries naming the same section in the two
      // spellings are one ask, and the cap counts it once.
      const ask = askRefOf(docs, h.domain, id);
      if (asks.length < limit && !seenAsk.has(ask)) { seenAsk.add(ask); asks.push(ask); }
    }
  }
  return { asks, warnings };
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
  const { asks: ids, warnings } = splitHits(docs, hits, ASK_SECTIONS);
  if (!ids.length && !warnings.length) return;
  const files = [...new Set(hits.flatMap((h) => h.files))];
  const kinds = [...new Set(hits.map((h) => h.kind))];
  state.asked = true;
  saveState(sessionKey(input), state);
  log(root, input, { event: 'ask-update', sections: ids, warnings: warnings.map((w) => w.id), files: files.slice(0, 5), kinds });
  let scope = 'It is written into the doc file itself.';
  try {
    const st = docs.status();
    if (st.mode.startsWith('overlay') && !st.mainline) scope = `It is saved for branch ${st.branch} only; mainline keeps its own text until the branch merges.`;
  } catch {}
  const subject = files.length === 1 ? 'this file' : 'these files';
  const parts = [];
  // The warning block leads, the ask block follows: an ask can be discharged with one reply ('docs still
  // hold') and reads as done; a warning can never be discharged at all, only reported. Printing it after
  // the ask would let a reader who answers the ask stop reading before ever reaching it.
  if (warnings.length) {
    const oneW = warnings.length === 1;
    if (oneW) parts.push(`A DECISION recorded by a person covers ${subject} - '${warnings[0].heading}', in ${warnings[0].file}:`, `  "${warnings[0].first}"`);
    else {
      parts.push(`${warnings.length} DECISIONS recorded by a person cover ${subject}:`);
      for (const w of warnings) parts.push('', `  '${w.heading}', in ${w.file}:`, `    "${w.first}"`);
    }
    parts.push('', oneW
      ? 'If your change makes that untrue, say so in your answer - this engine cannot rewrite it, only a person can.'
      : 'If your change makes any of those untrue, say so in your answer - this engine cannot rewrite them, only a person can.');
  }
  if (ids.length) {
    const one = ids.length === 1;
    if (warnings.length) parts.push('');
    parts.push(
      `One check before you finish. You changed ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''} (${kinds.join(', ')}), which ${one ? 'this section owns' : 'these sections own'}: ${ids.join(', ')}.`,
      `Open ${one ? 'it' : 'them'}: ${READ} show ${ids.join(' ')}`,
      'For each: if your change moved a rule, boundary, contract or pattern it states, rewrite that section - heading included, changing only what your change made untrue - and save it:',
      `  ${READ} set <file>#<id> <<'MD'`,
      '  <the whole section>',
      '  MD',
      `${scope} Leave out the captured line; set stamps it.`,
      `If ${one ? 'it still holds' : 'they still hold'}, reply 'docs still hold: ${ids.join(', ')}' and finish. Do not edit any other doc.`,
    );
  }
  process.stdout.write(JSON.stringify({
    followup_message: parts.join('\n'),
  }));
}

module.exports = { writeTargets, consultedBy, toolPaths };
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`docs-session: ${error.message}\n`); }
}
