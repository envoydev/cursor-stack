#!/usr/bin/env node
// memory-session.js - pushes the memory MCP's own stored memories into every session, on Cursor's
// sessionStart event. Adapted from the peer stack's hook of the same name for Cursor's hook contract
// (cursor.com/docs/hooks) - event name lowercased, payload read the way docs-session.js reads it
// (workspace_roots / cwd, no session-id lookup needed here), output shape { additional_context }
// instead of the peer's hookSpecificOutput wrapper, and the closing line names the memory MCP's tools
// directly - Cursor has no tool-search deferral to route through. memory.js (the engine) is copied
// beside this hook and not itself wired to an event - same split as docs.js beside docs-session.js.
// Silent wherever nothing can be shown: no memory server registered for this project, an empty
// selection, a missing/locked/wrong-schema database, a Node below 22.13 (memory.js's own
// selectForSession already degrades to an empty selection there), garbage or slow-to-arrive stdin, or
// any other error - exit 0 throughout, since a session start that cannot be enriched must never be a
// session start that fails.
'use strict';
const fs = require('fs');
const os = require('os');

const CAP_BYTES = 4096;
const STDIN_TIMEOUT_MS = 2000;
const TOOLS_LINE = "Store, search or list more with the memory MCP's memory_store / memory_search / memory_list tools.";

// Bounded stdin read: resolves with the parsed payload once stdin closes, or with {} after
// STDIN_TIMEOUT_MS if it never does - a hook whose stdin is never closed must not hang until the
// harness's own hook timeout kills it. `stream` is injectable for tests (defaults to process.stdin).
function readInput(stream = process.stdin) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { const v = JSON.parse(data || '{}'); resolve(v && typeof v === 'object' ? v : {}); } catch { resolve({}); }
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    try {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { data += chunk; });
      stream.on('end', () => { clearTimeout(timer); finish(); });
      stream.on('error', () => { clearTimeout(timer); finish(); });
    } catch { clearTimeout(timer); finish(); }
  });
}

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
  if (!text) return;
  const lines = [`Memory (memory MCP, ${level}):`, text, '', TOOLS_LINE];
  emit(lines.join('\n'));
}

module.exports = { main, readInput };
if (require.main === module) {
  main().catch(() => { /* a session start must never fail here - no output, exit 0 */ });
}
