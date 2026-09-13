// Behavior tests for the guard hooks, which had NO coverage at all - the hooks were ported from the
// peer stack and a port is exactly where a gate quietly stops gating. Each case pins a real
// regression: a silent evasion the gate exists to stop, or a false positive that blocked honest
// work. Both directions matter - a hook that fires on the wrong turn teaches the model to route
// around it, and the bypass it learns then defeats the gate on the turn that mattered.
//
// These drive the hooks the way Cursor does: the payload as JSON on stdin, an allow/deny permission
// object read back off stdout. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guards-'));

function ask(hook, payload, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CURSOR_DOCS_PATH: path.join(TMP, 'docs'), ...env },
  });
  try { return JSON.parse(r.stdout).permission; } catch { return `UNPARSEABLE: ${r.stdout}${r.stderr}`; }
}
const shell = (hook, command, extra = {}, env = {}) => ask(hook, { command, ...extra }, env);
const heredoc = (body, target = 'plan.md') => `cat <<'EOF' > ${target}\n${body}\nEOF`;

// A repo with `files` staged fixtures past the commit gate's 2-file / 15-line trivial bar.
function repo(files = 0) {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A'); git('commit', '-qm', 'seed');
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x\n'.repeat(30));
  git('add', '-A');
  return dir;
}
const headOf = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
function receipt(dir, name, body) {
  const d = path.join(dir, '.cursor', 'docs', 'flow');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), body);
}
const inRepo = (dir, command, env = {}) =>
  ask('guard-ungated-commit.js', { command, cwd: dir }, { CURSOR_DOCS_PATH: path.join(dir, '.cursor', 'docs'), ...env });

test('guard-catastrophic-rm: unrecoverable targets are refused, ordinary cleanup is not', () => {
  const RM = 'guard-catastrophic-rm.js';
  assert.equal(shell(RM, 'rm -rf ~'), 'deny', 'home');
  assert.equal(shell(RM, 'rm -rf "$HOME"/*'), 'deny', 'quoted prefix with the glob outside');
  assert.equal(shell(RM, 'rm -rf /usr /lib /etc'), 'deny', 'the multi-arg system wipe');
  assert.equal(shell(RM, 'rm -rf bin obj node_modules'), 'allow', 'ordinary build cleanup');
  assert.equal(shell(RM, 'rm -rf .playwright'), 'allow', 'one named directory');
  assert.equal(shell(RM, heredoc('never run rm -rf / on this box')), 'allow', 'a document describing it is data');
});

test('guard-catastrophic-rm: the git verbs that destroy a tree, and only while it is dirty', () => {
  // Git destroys uncommitted work with no reflog behind it, and this guard had zero git coverage -
  // a destructive `git checkout --` passed every guard in the stack. Gated on ACTUAL loss, so the
  // overwhelmingly common case of resetting an already-clean checkout stays silent.
  const RM = 'guard-catastrophic-rm.js';
  const dirty = repo(1);
  const clean = repo(0);
  assert.equal(shell(RM, 'git reset --hard', { cwd: dirty }), 'deny', 'reset --hard with work to lose');
  assert.equal(shell(RM, 'git reset --hard', { cwd: clean }), 'allow', 'nothing to destroy');
  assert.equal(shell(RM, 'git checkout -- .', { cwd: dirty }), 'deny', 'checkout --');
  assert.equal(shell(RM, 'git clean -fd', { cwd: dirty }), 'deny', 'clean -f');
  assert.equal(shell(RM, 'git restore --staged f0.txt', { cwd: dirty }), 'allow', '--staged moves nothing on disk');
  assert.equal(shell(RM, "echo 'git reset --hard'", { cwd: dirty }), 'allow',
    'a quoted span is data - denying it teaches the obfuscation that defeats this gate for real');
});

test('guard-protected-force-push: a shared branch cannot be rewritten or deleted', () => {
  const FP = 'guard-protected-force-push.js';
  assert.equal(shell(FP, 'git push --force origin main'), 'deny');
  assert.equal(shell(FP, 'git push origin :main'), 'deny', 'the empty-source deletion refspec');
  assert.equal(shell(FP, 'git push --mirror origin'), 'deny');
  assert.equal(shell(FP, 'git push --force origin my-feature'), 'allow', 'a feature branch is yours');
  assert.equal(shell(FP, 'git push origin main'), 'allow', 'a fast-forward push is not a rewrite');
  assert.equal(shell(FP, 'echo "git push --force origin main"'), 'allow',
    'the verb must be the segment\'s own command, not a substring of another program\'s argument');
});

test('guard-ungated-commit: a non-trivial commit needs its receipt, a trivial one does not', () => {
  const big = repo(4);
  assert.equal(inRepo(big, 'git commit -m x'), 'deny', 'four fixtures and no receipt');
  assert.equal(inRepo(big, heredoc('then run git commit -m x')), 'allow', 'a plan describing a commit is data');
  const small = repo(0);
  fs.writeFileSync(path.join(small, 'seed.txt'), 'seed2\n');
  spawnSync('git', ['-C', small, 'add', '-A']);
  assert.equal(inRepo(small, 'git commit -m x'), 'allow', 'one file, one line - the rule\'s own exemption');
});

test('guard-ungated-commit: the five-line receipt contract', () => {
  // Each line answers a way a receipt was measured passing while recording nothing: `head:` proves
  // it reviewed THIS tree, `spec:` proves it covered the whole diff, `live-probe:` proves it ran the
  // thing, and the quoted words must be the USER asking for this act.
  const conformant = (dir) =>
    `VERIFIED the four fixtures\nauthorized: "commit it"\nhead: ${headOf(dir)}\nspec: 4 files - the fixtures\nlive-probe: tests green\n`;
  let dir = repo(4);
  receipt(dir, 'COMMIT-GATE', conformant(dir));
  assert.equal(inRepo(dir, 'git commit -m x'), 'allow', 'a conformant receipt passes');

  dir = repo(4);
  receipt(dir, 'COMMIT-GATE', 'VERIFIED the four fixtures\nauthorized: "commit it"\n');
  assert.equal(inRepo(dir, 'git commit -m x'), 'deny', 'the old two-line receipt no longer holds');

  dir = repo(4);
  receipt(dir, 'COMMIT-GATE',
    `VERIFIED x\nauthorized: "what time is it?"\nhead: ${headOf(dir)}\nspec: 4 files\nlive-probe: NOT RUN - no suite\n`);
  assert.equal(inRepo(dir, 'git commit -m x'), 'deny',
    'a quote with no commit verb records the user saying something, not asking for THIS act');

  dir = repo(4);
  receipt(dir, 'COMMIT-GATE', 'WAIVED - "just commit it, skip the review"\n');
  assert.equal(inRepo(dir, 'git commit -m x'), 'allow', 'an explicit waiver in the user\'s own words');
});

test('guard-ungated-commit: an absolute docs root inside the repo does not fail its own receipt', () => {
  // The receipt lives under the docs root, so it is itself an untracked changed file. Excluding it
  // only for a RELATIVE root meant an absolute in-repo root made every conformant receipt fail its
  // own `spec:` count - the gate blocking the commit it had just authorized.
  const dir = repo(4);
  const docs = path.join(dir, '.cursor', 'docs');
  receipt(dir, 'COMMIT-GATE',
    `VERIFIED the four fixtures\nauthorized: "commit it"\nhead: ${headOf(dir)}\nspec: 4 files\nlive-probe: tests green\n`);
  assert.equal(ask('guard-ungated-commit.js', { command: 'git commit -m x', cwd: dir }, { CURSOR_DOCS_PATH: docs }),
    'allow', 'an absolute in-repo docs root is excluded from the changed-file count');
});

test('guard-ungated-commit: publishing carries the same ceremony', () => {
  // `git push` puts the work where other people and CI get it, and a shared branch cannot be
  // un-pushed quietly. Nothing gated it before: replayed across four bundles on the peer stack,
  // every push and merge passed every guard.
  let dir = repo(0);
  assert.equal(inRepo(dir, 'git push origin main'), 'deny', 'no PUSH-GATE receipt');
  receipt(dir, 'PUSH-GATE',
    `VERIFIED one commit\nauthorized: "push it"\nhead: ${headOf(dir)}\nspec: 1 commit to origin/main\nlive-probe: tests green\n`);
  assert.equal(inRepo(dir, 'git push origin main'), 'allow', 'a conformant publish receipt');

  dir = repo(0);
  assert.equal(inRepo(dir, 'git push --dry-run origin main'), 'allow', 'a dry run publishes nothing');
  assert.equal(inRepo(dir, 'git push origin main', { CURSOR_PUSH_GATE: '0' }), 'allow',
    'the half switches off where the remote is already gated');
  assert.equal(inRepo(dir, 'ls -la'), 'allow', 'an unrelated command is never judged');
});

// --- the ports that followed: each case below pins a peer-stack fix brought across --------------
function askBody(hook, payload, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CURSOR_DOCS_PATH: path.join(TMP, 'docs'), ...env },
  });
  try { return JSON.parse(r.stdout); } catch { return { permission: `UNPARSEABLE: ${r.stdout}${r.stderr}` }; }
}

test('guard-catastrophic-rm: the gate reads the PATHSPEC, and honours a discard receipt', () => {
  // It asked only 'is the tree dirty', which made its own prescribed escape - 'name the ONE file to
  // revert instead of the whole tree' - unreachable: `git restore .gitignore` was denied with all
  // seven dirty files listed, six of which the command never touched (measured on the peer stack).
  const RM = 'guard-catastrophic-rm.js';
  const dir = repo(0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  spawnSync('git', ['-C', dir, 'add', '-A']);
  spawnSync('git', ['-C', dir, 'commit', '-qm', 'two files']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one changed\n'); // only a.txt is dirty
  const docs = path.join(dir, '.cursor', 'docs');
  const rm = (command) => askBody(RM, { command, cwd: dir }, { CURSOR_DOCS_PATH: docs });

  assert.equal(rm('git restore b.txt').permission, 'allow', 'a CLEAN path has nothing to lose, dirty tree or not');
  // argv, never a shell string: a single-quoted pathspec reached cmd.exe on Windows as a file
  // literally named 'a.txt' with the quotes, found clean, and passed (the peer's windows CI job).
  assert.equal(rm('git restore "a.txt"').permission, 'deny', 'the dirty path it names is still blocked, quoted or not');
  assert.equal(rm('git checkout -- .').permission, 'deny', 'the whole tree keeps the old arithmetic');
  const denied = rm('git restore a.txt');
  assert.match(denied.agent_message, /the path\(s\) this command names/, 'the denial says which scope it judged');
  assert.match(denied.agent_message, /DISCARD-ALLOW/, 'and names the receipt that honours a discard');
  assert.match(denied.agent_message, /ONE question to the user/, 'ending in an ask the user answers');
  assert.doesNotMatch(denied.agent_message, /AGENTS\.md|AskUserQuestion/, 'no prose copy to cite, no tool this platform lacks');

  const flow = path.join(docs, 'flow');
  fs.mkdirSync(flow, { recursive: true });
  // The receipt lives under the docs root, which is itself inside the repo here - so it is an
  // untracked file of its own; a pathspec command never looks at it.
  fs.writeFileSync(path.join(flow, 'DISCARD-ALLOW'), '# the user answered Discard it\na.txt\n');
  assert.equal(rm('git restore a.txt').permission, 'allow', 'the receipt is honoured for the path it names');
  assert.equal(rm('git checkout -- .').permission, 'deny', 'but it does not cover the whole tree');
  fs.writeFileSync(path.join(flow, 'DISCARD-ALLOW'), '*\n');
  assert.equal(rm('git checkout -- .').permission, 'allow', 'the * line does');
  const old = new Date(Date.now() - 9 * 3600 * 1000);
  fs.utimesSync(path.join(flow, 'DISCARD-ALLOW'), old, old);
  assert.equal(rm('git checkout -- .').permission, 'deny', 'a receipt older than 8h reads as absent');
});

test('guard-protected-force-push: the denial cites no prose copy of the rule', () => {
  const r = askBody('guard-protected-force-push.js', { command: 'git push --force origin main' });
  assert.equal(r.permission, 'deny');
  assert.doesNotMatch(r.agent_message, /AGENTS\.md/, 'the template carries no copy of this rule to consult');
});

// Read-guard fixtures: a large and a small source file, and a scratch session per test.
const SRC = fs.mkdtempSync(path.join(TMP, 'src-'));
const BIG = path.join(SRC, 'big.js');
fs.writeFileSync(BIG, Array.from({ length: 400 }, (_, i) => `const v${i} = ${i}; // function ${i}`).join('\n') + '\n');
const SMALL = path.join(SRC, 'small.js');
fs.writeFileSync(SMALL, 'module.exports = 1;\n');
const RW = 'guard-read-whole-file.js';
const rwShell = (command, extra = {}) => ask(RW, { hook_event_name: 'beforeShellExecution', command, cwd: TMP, ...extra });
let convo = 0;
const rwRead = (file_path, content, conversation_id = `c-${process.pid}-${++convo}`) =>
  ask(RW, { hook_event_name: 'beforeReadFile', file_path, content, conversation_id });

test('guard-read-whole-file: the extension is judged against the PATH, not the whole line', () => {
  // Every one of these was a replayed false positive on the peer stack: the extension was tested
  // against the WHOLE compound command, and the sweep test ran above the per-segment loop.
  assert.equal(rwShell(`ls src/*.js && head -40 ${BIG}`), 'allow', 'an unrelated *.js glob in a SIBLING segment');
  assert.equal(rwShell(`find . -name "guard-read-whole-file.js" && grep -n THRESHOLD ${BIG} | head -20`), 'allow',
    'an exact-filename find names ONE file');
  assert.equal(rwShell('head -n 100000 notes.txt # about Foo.cs'), 'allow', 'a huge head of a NON-gated file');
  assert.equal(rwShell(`cat ${BIG} > ${path.join(TMP, 'copy.js')}`), 'allow', 'a redirect into a file is a copy, not a dump');
  assert.equal(rwShell(`cat ${BIG} 2>&1`), 'deny', 'an fd redirect still prints');
  assert.equal(rwShell('for f in src/*.cs; do cat -n "$f"; done'), 'deny', 'a loop still blocks');
  assert.equal(rwShell('find . -name "*.cs" -exec cat {} +'), 'deny', 'a globbed find -exec cat still blocks');
});

test('guard-read-whole-file: an unexpanded $VAR is judged by nobody, and a leading cd moves the anchor', () => {
  assert.equal(rwShell('cat $R/src/Thing.cs'), 'allow', 'an unexpanded variable target is not judged');
  assert.equal(rwShell('cat ${SRC}/Thing.ts'), 'allow', 'the braced spelling either');
  assert.equal(rwShell(`R=${SRC} && cat $R/big.js`), 'deny', 'a same-command assignment is expanded and judged');
  assert.equal(rwShell(`cd ${SRC} && cat big.js`), 'deny', 'a cd-anchored relative dump is still caught');
  assert.equal(rwShell(`cd ${SRC} && cat small.js`), 'allow', 'and a small one still passes');
});

test('guard-read-whole-file: a runtime expression that only COUNTS is not a dump', () => {
  // Measured on the peer stack: a `node -e` whose whole output was `.match(...).length` was denied,
  // killing a five-probe compound command and costing a 107k-token retry.
  assert.equal(rwShell(`node -e 'console.log(require("fs").readFileSync("${BIG}","utf8").match(/function/g).length)'`), 'allow', 'a count');
  assert.equal(rwShell(`node -e 'console.log(require("fs").readFileSync("${BIG}","utf8").split("\\n").length)'`), 'allow', 'a line count');
  assert.equal(rwShell(`node -e 'console.log(require("fs").readFileSync("${BIG}","utf8"))'`), 'deny', 'printing the content still is');
  assert.equal(rwShell(`node -e 'console.log(require("fs").readFileSync("${SMALL}","utf8"))'`), 'allow', 'a small file is fine, like cat');
});

test('guard-read-whole-file: a sweep over .md files is a sweep; one named .md file is not', () => {
  // 84.1KB from 35 SKILL.md files in one call, 120KB from 46 in another (peer stack).
  assert.equal(rwShell('for f in .cursor/skills/*/SKILL.md; do cat "$f"; done'), 'deny', 'a loop over every SKILL.md');
  assert.equal(rwShell('find .cursor/skills -name SKILL.md -exec cat {} \;'), 'deny', 'find -exec over the same set - a literal .md name repeats per directory');
  assert.equal(rwShell(`cat ${path.join(__dirname, '..', 'CLAUDE.md')}`), 'allow', 'one named markdown file is a fine read');
});

test('guard-read-whole-file: beforeReadFile judges the whole-file SHAPE, merges coverage, and gates any oversized file', () => {
  const text = fs.readFileSync(BIG, 'utf8');
  const lines = text.split('\n');
  const slice = (a, b) => lines.slice(a, b).join('\n');
  assert.equal(rwRead(BIG, text), 'deny', 'content covering the whole file');
  assert.equal(rwRead(BIG, slice(0, 220)), 'allow', 'a window past the threshold but well short of the file is targeted');

  const c = `c-merge-${process.pid}`;
  assert.equal(rwRead(BIG, slice(0, 120), c), 'allow', 'first 30%');
  assert.equal(rwRead(BIG, slice(0, 120), c), 'allow', 're-reading the SAME range is one range, not two');
  assert.equal(rwRead(BIG, slice(120, 240), c), 'allow', 'second 30% - at the cap');
  assert.equal(rwRead(BIG, slice(240, 360), c), 'deny', 'the third reconstructs the file');
  assert.equal(rwRead(BIG, slice(240, 250), c), 'deny', 'the blocked read was not counted, but the cap already holds');
  assert.equal(rwRead(BIG, slice(240, 360), `${c}-other`), 'allow', 'the cap is per conversation');

  // A 93KB spill read WHOLE, twice, for 99,277 chars on the peer stack - the extension was not gated.
  const spill = path.join(SRC, 'persisted-output.txt');
  fs.writeFileSync(spill, 'x'.repeat(70 * 1024));
  assert.equal(rwRead(spill, fs.readFileSync(spill, 'utf8')), 'deny', 'an oversized file read whole, whatever its extension');
  const log = path.join(SRC, 'big.log');
  fs.writeFileSync(log, Array.from({ length: 3000 }, (_, i) => `line ${i} ${'y'.repeat(30)}`).join('\n'));
  assert.equal(rwRead(log, fs.readFileSync(log, 'utf8').split('\n').slice(0, 50).join('\n')), 'allow', 'a ranged read of one passes');
  assert.equal(rwRead(path.join(__dirname, '..', 'CLAUDE.md'), fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8')), 'allow',
    'a small non-source file is untouched');
});

test('guard-read-whole-file: a block appends one ledger row', () => {
  const docs = fs.mkdtempSync(path.join(TMP, 'rw-docs-'));
  assert.equal(ask(RW, { hook_event_name: 'beforeShellExecution', command: `cat ${BIG}`, cwd: TMP, session_id: 'rw' }, { CURSOR_DOCS_PATH: docs }), 'deny');
  const rows = fs.readFileSync(path.join(docs, 'hook-blocks', 'rw.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hook, RW);
  assert.equal(rows[0].event, 'beforeShellExecution');
});

test('guard-unapproved-dispatch: a SYMBOL question never goes to the grep-shaped explore seat', () => {
  // Measured on the peer stack: a C# symbol hunt handed to a search seat came back as grep hits.
  const root = fs.mkdtempSync(path.join(TMP, 'proj-'));
  const docs = path.join(root, '.cursor', 'docs');
  const disp = (subagent_type, task) => askBody('guard-unapproved-dispatch.js',
    { subagent_type, task, workspace_roots: [root], session_id: 'disp' }, { CURSOR_DOCS_PATH: docs });
  const denied = disp('explore', 'Who calls OrderService.Submit across the solution?');
  assert.equal(denied.permission, 'deny', 'who calls');
  assert.match(denied.agent_message, /serena find_symbol/, 'sent back to serena, inline');
  assert.equal(disp('explore', 'find the definition of RetryPolicy').permission, 'deny', 'a definition lookup');
  assert.equal(disp('explore', 'map the auth module and list the files that configure logging').permission, 'allow',
    'a broad sweep with no symbol question');
  assert.equal(disp('generalPurpose', 'update every usages of the old logger').permission, 'allow',
    'generalPurpose may be a named seat on this platform, so it is not judged');
  const rows = fs.readFileSync(path.join(docs, 'hook-blocks', 'disp.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2, 'one ledger row per block');

  const stale = disp('generalPurpose', 'run aspnet-implementer on task 1');
  assert.equal(stale.permission, 'deny', 'no stamp');
  fs.mkdirSync(path.join(docs, 'flow'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'flow', 'APPROVAL'), 'APPROVED plan-1 - "go"\n');
  const old = (Date.now() - 9 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(docs, 'flow', 'APPROVAL'), old, old);
  assert.match(disp('generalPurpose', 'run aspnet-implementer on task 1').agent_message, /older than 8h, or written before this session began/,
    'a stale stamp says both ways it can be stale');
});

test('guard-ungated-commit: a receipt naming the review skill is not refused for a transcript this platform cannot show', () => {
  // The peer's check reads a `"name":"Skill"` row out of the transcript. Cursor records a skill as
  // a read of its SKILL.md, so that row never exists here - and an absent row read as 'the review
  // never ran' blocked every conformant receipt naming project-verify-code, the very review this
  // gate's own denial prescribes (reproduced with and without a transcript_path).
  const dir = repo(4);
  receipt(dir, 'COMMIT-GATE',
    `VERIFIED project-verify-code over the fixtures\nauthorized: "commit it"\nhead: ${headOf(dir)}\nspec: 4 files\nlive-probe: tests green\n`);
  assert.equal(inRepo(dir, 'git commit -m x'), 'allow', 'no transcript');
  const tp = path.join(TMP, 'cursor-transcript.jsonl');
  fs.writeFileSync(tp, '{"type":"tool_call","tool_call":{"readToolCall":{"args":{"path":"skills/project-verify-code/SKILL.md"}}}}\n');
  assert.equal(ask('guard-ungated-commit.js', { command: 'git commit -m x', cwd: dir, transcript_path: tp },
    { CURSOR_DOCS_PATH: path.join(dir, '.cursor', 'docs') }), 'allow', 'a Cursor-shaped transcript');

  const bare = repo(4);
  const r = askBody('guard-ungated-commit.js', { command: 'git commit -m x', cwd: bare }, { CURSOR_DOCS_PATH: path.join(bare, '.cursor', 'docs') });
  assert.equal(r.permission, 'deny');
  assert.match(r.agent_message, /project-commit-checkpoint skill/, 'the denial names where the checkpoint protocol lives');
});
