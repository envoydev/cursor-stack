#!/usr/bin/env node
// memory-session.js - pushes the memory MCP's own stored memories into every session, on Cursor's
// sessionStart event. Adapted from the peer stack's hook of the same name for Cursor's hook contract
// (cursor.com/docs/hooks) - event name lowercased, payload read the way docs-session.js reads it
// (workspace_roots / cwd, no session-id lookup needed here), output shape { additional_context }
// instead of the peer's hookSpecificOutput wrapper, and the closing line names the memory MCP's tools
// directly - Cursor has no tool-search deferral to route through. memory.js (the engine) is copied
// beside this hook and not itself wired to an event - same split as docs.js beside docs-session.js.
// Whenever a memory registration is found, the push always names this project's own tag (even with
// nothing else to show - I5), so the model knows what to save under, especially inside a git
// worktree, where that name is the MAIN checkout's, never the worktree's own folder. Fully silent
// only when there is no registration to report at all: a missing/locked/wrong-schema database, a
// Node below 22.13 (memory.js's own selectForSession already degrades to an empty selection there),
// garbage or slow-to-arrive stdin, or any other error - exit 0 throughout, since a session start that
// cannot be enriched must never be a session start that fails.
'use strict';
const os = require('os');

const CAP_BYTES = 4096;
const STDIN_TIMEOUT_MS = 2000;
const TOOLS_LINE = "Store, search or list more with the memory MCP's memory_store / memory_search / memory_list tools.";

// A plain stdin read blocks forever when stdin never closes (a TTY, or a harness that keeps the pipe
// open) - this hook only ever needs `cwd`/`workspace_roots` out of the payload, and those already
// have a process.cwd() fallback below, so giving up after STDIN_TIMEOUT_MS and treating the payload
// as empty costs nothing but the sessionStart push for that one unreadable call. The timer is
// deliberately NOT unref'd: a resumed stdin keeps the event loop alive on its own, and an unref'd
// stdin (tried first, measured) lets the loop see itself as empty and exit within milliseconds -
// before either the data/end event OR the timeout ever fires. `finish()`'s own `pause()` +
// `removeAllListeners()` is what actually drops the ref once this settles; `process.exit(0)` right
// after `main()` below is the real bound, independent of any of this - ported from the peer stack's
// memory-session.js after its own port of this hook reproduced the exact stdin-hang bug that fix
// addressed (an open pipe nobody writes to or closes kept the process alive past the timer, because
// the timer firing only resolved the promise - it never released the still-attached listeners).
function readStdinBounded(timeoutMs) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.stdin.pause(); process.stdin.removeAllListeners('data'); process.stdin.removeAllListeners('end'); process.stdin.removeAllListeners('error'); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => finish(data));
      process.stdin.on('error', () => finish(data));
      process.stdin.resume();
    } catch { finish(''); }
  });
}

const readInput = async () => {
  const raw = await readStdinBounded(STDIN_TIMEOUT_MS);
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

const emit = (text) => process.stdout.write(JSON.stringify({ additional_context: text }));

async function main() {
  const input = await readInput();
  if (input.hook_event_name !== 'sessionStart') return;
  const root = (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || input.cwd || process.cwd();
  // memory.js itself needs no env bridge (projectRoot is an explicit argument throughout), but
  // relatedProjects below borrows docs.js's DOCS_ROOT, and that engine reads CLAUDE_PROJECT_DIR
  // unconditionally (see docs-session.js's own header note - a hook process's own cwd is not reliably
  // the project root the way a model-run shell command's is).
  process.env.CLAUDE_PROJECT_DIR = root;
  const memory = require('./memory.js');
  const home = os.homedir();
  const dbPath = memory.registeredDbPath(root, { home });
  if (!dbPath) return; // no memory server registered for this project - nothing to push
  const level = memory.levelOfPath(dbPath, { home, projectRoot: root }) || 'unknown';
  const project = memory.projectName(root);
  let related = [];
  try { related = memory.relatedProjects(root, require('./docs.js').DOCS_ROOT); } catch {}
  const { text } = memory.selectForSession(dbPath, { project, related, capBytes: CAP_BYTES });
  // Whenever a memory registration exists, the model needs its own project's tag to save under -
  // even (especially) inside a git worktree, where projectName() already names the MAIN checkout,
  // never the worktree's own folder (I5). Nothing selected: keep the push to just this line plus the
  // tools line, no header, no body - still short enough to never be worth suppressing.
  const tagLine = `This project's memory tag: project:${project}`;
  const lines = text
    ? [`Memory (memory MCP, ${level}):`, tagLine, text, '', TOOLS_LINE]
    : [tagLine, TOOLS_LINE];
  emit(lines.join('\n'));
}

module.exports = { main };
if (require.main === module) {
  // process.exit(0) rather than letting the event loop drain on its own: a stdin handle the bounded
  // read above could not fully detach from must never keep this process alive past its own work.
  main().catch(() => {}).then(() => process.exit(0));
}
