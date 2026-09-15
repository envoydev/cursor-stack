// Behavior tests for hooks/guard-secret-value.js - a credential is read for its PRESENCE, never its
// value. The judgement is ported from the peer stack verbatim, so these pin it through Cursor's three
// boundaries: preToolUse on the Shell tool (the dump is REWRITTEN through updated_input),
// beforeShellExecution (the same verdict can only be a denial), and beforeReadFile. Every fixture is
// fake by construction, and the hook runs against a fake HOME, so no real credential is ever read.
// Run with `npm test`.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'guard-secret-value.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guard-secret-'));
const ROOT = fs.mkdtempSync(path.join(TMP, 'root-'));
const HOME = fs.mkdtempSync(path.join(TMP, 'home-'));
const LEDGER = path.join(TMP, 'docs');

// Not a run of one character: a value that is just `xxx...` is a placeholder by content.
const FAKE_TOKEN = 'x0'.repeat(20);
const FAKE_JWT = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnopqrstuvwxyz0123'].join('.');
const SECRET_JSON = JSON.stringify({ env: { SENTRY_SLUG: 'acme', SENTRY_ACCESS_TOKEN: FAKE_TOKEN }, hooks: {} }, null, 2);

fs.mkdirSync(path.join(ROOT, 'sub'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'sub', 'mcp.json'), SECRET_JSON);

const w = (name, content) => { const p = path.join(ROOT, name); fs.writeFileSync(p, content); return p; };
const F = {
  secret: w('settings.json', SECRET_JSON),
  dotenv: w('.env.local', 'DB_HOST=localhost\nAPI_KEY=abc123\n'),
  crlf: w('crlf.env', 'DB_HOST=localhost\r\nAPI_KEY=abc123\r\n'),
  nested: w('appsettings.json', JSON.stringify({ ConnectionStrings: { Default: 'Server=x' }, Smtp: { Password: 'p@ss' } })),
  clean: w('clean.json', JSON.stringify({ env: { CURSOR_DOCS_PATH: '.cursor/docs' } }, null, 2)),
  // The false positives a key name alone cannot separate - an i18n label, a public key, a template.
  i18n: w('en.json', JSON.stringify({ login: { password: 'Password', apiKey: 'API key' } }, null, 2)),
  manifest: w('manifest.json', JSON.stringify({ manifest_version: 3, key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' }, null, 2)),
  example: w('.env.example', 'API_KEY=your-api-key-here\n'),
  // Cursor's own mcp.json spelling of a placeholder is a reference, not a value.
  mcp: w('mcp.json', JSON.stringify({ mcpServers: { context7: { headers: { CONTEXT7_API_KEY: '${env:CONTEXT7_API_KEY}' } } } }, null, 2)),
  code: w('index.js', 'const TOKEN = process.env.TOKEN;\nmodule.exports = TOKEN;\n'),
};

const ENV = { ...process.env, HOME, USERPROFILE: HOME, CURSOR_PROJECT_DIR: ROOT, CURSOR_DOCS_PATH: LEDGER };
const run = (payload, env = {}) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...ENV, ...env } });
const body = (r) => { try { return JSON.parse(r.stdout); } catch { return { permission: `UNPARSEABLE: ${r.stdout}${r.stderr}` }; } };

// preToolUse on the Shell tool: 'deny', 'allow', or 'rewrite' when the call was replaced.
const preTool = (command, env) => run({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command, working_directory: ROOT }, cwd: ROOT, session_id: 'suite' }, env);
const verdict = (r) => { const b = body(r); return b.updated_input ? 'rewrite' : b.permission; };
const pre = (command, env) => verdict(preTool(command, env));
const rewritten = (command) => (body(preTool(command)).updated_input || {}).command;
// beforeShellExecution: allow / deny only.
const shellRun = (command, env) => run({ hook_event_name: 'beforeShellExecution', command, cwd: ROOT, session_id: 'suite' }, env);
const shell = (command, env) => body(shellRun(command, env)).permission;
const readRun = (file_path, env) => run({ hook_event_name: 'beforeReadFile', file_path, content: fs.existsSync(file_path) ? fs.readFileSync(file_path, 'utf8') : '', session_id: 'suite' }, env);
const read = (file_path, env) => body(readRun(file_path, env)).permission;
const cli = (...args) => spawnSync(process.execPath, [HOOK, ...args], { encoding: 'utf8', env: ENV });

test('guard-secret-value: a dump of a file holding a credential is judged by CONTENT', () => {
  assert.equal(pre(`cat ${F.secret}`), 'rewrite', 'cat of a settings file with a live token');
  assert.equal(pre(`jq .env ${F.secret}`), 'rewrite', 'jq of the env block');
  assert.equal(pre(`grep -n SENTRY ${F.secret}`), 'rewrite', 'grep prints the matching line, value included');
  assert.equal(pre(`cat ${F.dotenv}`), 'rewrite', 'a dotenv with API_KEY=value');
  assert.equal(pre(`cat ${F.crlf}`), 'rewrite', 'a CRLF dotenv reads like an LF one');
  assert.equal(pre(`cat ${F.nested}`), 'rewrite', 'a nested Smtp.Password');
  assert.equal(pre(`cat ${F.clean}`), 'allow', 'no credential-shaped key');
  assert.equal(pre(`cat ${F.mcp}`), 'allow', 'a ${env:VAR} placeholder is not a live value');
  assert.equal(pre(`cat ${F.i18n}`), 'allow', 'an i18n label under a password key is a sample');
  assert.equal(pre(`cat ${F.manifest}`), 'allow', 'a public key is not a credential');
  assert.equal(pre(`cat ${F.example}`), 'allow', 'a .example file ships keys, never values');
  assert.equal(pre(`cat ${F.code}`), 'allow', 'source code is never a credential file');
  assert.equal(pre('cat "$SOME_UNSET_DIR/settings.json"'), 'allow', 'an unexpanded variable is never judged');
});

test('guard-secret-value: preToolUse rewrites the dump into its redacted view, keeping the rest of the input', () => {
  const r = body(preTool(`cat ${F.secret}`));
  assert.equal(r.permission, 'allow', 'a rewrite is not a denial - no retried turn');
  assert.equal(r.updated_input.command, `node "${HOOK}" --redacted "${F.secret}"`, 'the call becomes the redacted view of that file');
  assert.equal(r.updated_input.working_directory, ROOT, 'the other tool input fields survive the rewrite');
  assert.equal(rewritten('cd sub && cat mcp.json && ls'), `node "${HOOK}" --redacted "${path.join(ROOT, 'sub', 'mcp.json')}"`,
    'a cd moves the anchor, and the first credential file wins');

  const view = cli('--redacted', F.secret);
  assert.equal(view.status, 0);
  assert.doesNotMatch(view.stdout + view.stderr, new RegExp(FAKE_TOKEN), 'the value never appears');
  assert.match(view.stdout, /"SENTRY_ACCESS_TOKEN": "<set \(40 chars\)>"/, 'masked in place, by length');
  assert.match(view.stdout, /"SENTRY_SLUG": "acme"/, 'a non-secret value stays readable');
  assert.match(view.stdout, /^# credential guard: redacted view of /, 'the header says what happened');
  assert.match(view.stdout, /ONE question to the user/, 'and how to get the value when the user needs it');
  assert.doesNotMatch(view.stdout, /AskUserQuestion/, 'no tool this platform does not have');
});

test('guard-secret-value: a variable print and an environment dump become their presence forms', () => {
  const v = rewritten('echo $SENTRY_ACCESS_TOKEN');
  assert.match(v, /\[ -n "\$SENTRY_ACCESS_TOKEN" \] && echo "SENTRY_ACCESS_TOKEN=set \(\$\{#SENTRY_ACCESS_TOKEN\} chars\)" \|\| echo "SENTRY_ACCESS_TOKEN=absent"/);
  assert.equal(rewritten('node -e "console.log(process.env.SENTRY_ACCESS_TOKEN)"'), v, 'a runtime print of the same variable');
  assert.equal(rewritten('printenv SENTRY_ACCESS_TOKEN'), v, 'printenv NAME');
  assert.equal(rewritten('env'), `node "${HOOK}" --redacted-env`, 'a whole-environment dump');
  assert.equal(pre('echo ${#SENTRY_ACCESS_TOKEN}'), 'allow', 'a length is presence');
  assert.equal(pre('set -e'), 'allow', 'a shell option is not a dump');

  const listing = spawnSync(process.execPath, [HOOK, '--redacted-env'], { encoding: 'utf8', env: { ...ENV, SENTRY_ACCESS_TOKEN: FAKE_TOKEN, PLAIN_VALUE: 'visible' } });
  assert.doesNotMatch(listing.stdout, new RegExp(FAKE_TOKEN));
  assert.match(listing.stdout, /^SENTRY_ACCESS_TOKEN=<set \(40 chars\)>$/m);
  assert.match(listing.stdout, /^PLAIN_VALUE=visible$/m);
});

test('guard-secret-value: beforeShellExecution has no rewrite channel, so the same verdict is a denial naming the redacted command', () => {
  const r = body(shellRun(`cat ${F.secret}`));
  assert.equal(r.permission, 'deny');
  assert.match(r.agent_message, new RegExp(`--redacted "${F.secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), 'the exact command to run instead');
  assert.match(r.agent_message, /Presence only \(Recommended\)/, 'and the ask, for when the value itself is needed');
  assert.equal(shell('env'), 'deny', 'an environment dump');
  assert.equal(shell(`cat ${F.clean}`), 'allow', 'a clean file');
  // Wired beside preToolUse this event is the net: every rewrite preToolUse produces must pass it,
  // or the two events together would deny the very call the rewrite handed the model.
  for (const cmd of [`cat ${F.secret}`, 'echo $SENTRY_ACCESS_TOKEN', 'env']) {
    const next = rewritten(cmd);
    assert.ok(next, `'${cmd}' is rewritten at all`);
    assert.equal(shell(next), 'allow', `the rewrite of '${cmd}' passes the shell event`);
  }
});

test('guard-secret-value: copies, edits, presence-shaped pipelines, prose and the rotation snippet stay silent', () => {
  assert.equal(pre(`cat ${F.secret} > ${path.join(TMP, 'copy.json')}`), 'allow', 'output into a file never reaches the context');
  assert.equal(pre(`grep -c SENTRY_ACCESS_TOKEN ${F.secret}`), 'allow', 'a count is presence');
  assert.equal(pre(`jq '.env | keys' ${F.secret}`), 'allow', 'keys only is presence');
  assert.equal(pre(`cat ${F.secret} | wc -l`), 'allow', 'a line count is presence');
  assert.equal(pre(`node -e "console.log(Object.keys(require('${F.secret}').env))"`), 'allow', 'a runtime key list is names, not values');
  assert.equal(pre(`cat <<'EOF' > ${path.join(TMP, 'plan.md')}\nStep 1: cat ${F.secret} to check the env block\nEOF`), 'allow', 'a heredoc body is prose');
  assert.equal(pre(`printf '%s\\n' "edit ${F.secret} by hand"`), 'allow', 'a print stage that only NAMES the file reads nothing');
  assert.equal(pre(`node "${HOOK}" --presence "${F.secret}" SENTRY_ACCESS_TOKEN`), 'allow', 'the sanctioned presence read');
  assert.equal(pre(`true && node "${HOOK}" --presence "${F.secret}" && cat ${F.secret}`), 'rewrite', 'but a dump chained after it is still a dump');
  assert.equal(pre(`python3 - <<'EOF'\nimport json;print(json.load(open('${F.secret}')))\nEOF`), 'rewrite', 'a heredoc feeding a runtime is code');
});

test('guard-secret-value: a credential-shaped literal is blocked on both shell events, and the ledger never holds it', () => {
  const docs = path.join(TMP, 'ledger-docs');
  assert.equal(pre(`curl -H "Authorization: Bearer ${FAKE_JWT}" https://example.test/api`, { CURSOR_DOCS_PATH: docs }), 'deny');
  assert.equal(shell(`echo 'TOKEN=${'ghp_' + 'A'.repeat(24)}' >> .env`, { CURSOR_DOCS_PATH: docs }), 'deny');
  assert.equal(pre(`cat ${F.secret}`, { CURSOR_DOCS_PATH: docs }), 'rewrite', 'a rewrite is not a block');
  const rows = fs.readFileSync(path.join(docs, 'hook-blocks', 'suite.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, 'one row per block, none for the rewrite');
  assert.deepEqual(rows.map((r) => r.event), ['preToolUse', 'beforeShellExecution']);
  assert.ok(rows.every((r) => r.hook === 'guard-secret-value.js'));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${FAKE_JWT}|ghp_A{24}`), 'the value is never logged');
});

test('guard-secret-value: beforeReadFile denies a file holding a credential, judged by content', () => {
  const r = body(readRun(F.secret));
  assert.equal(r.permission, 'deny');
  assert.match(r.agent_message, /SENTRY_ACCESS_TOKEN/, 'names the KEY');
  assert.doesNotMatch(r.agent_message + r.user_message, new RegExp(FAKE_TOKEN), 'never the value');
  assert.match(r.agent_message, /--presence/, 'and the sanctioned read');
  assert.equal(read(F.dotenv), 'deny', 'a dotenv');
  assert.equal(read(F.clean), 'allow', 'a clean file');
  assert.equal(read(F.mcp), 'allow', 'a placeholder mcp.json');
  assert.equal(read(path.join(ROOT, 'missing.json')), 'allow', 'a missing file has nothing to judge');
});

test("guard-secret-value: the user's 'show it' answer is honoured through a session receipt", () => {
  const receipt = path.join(LEDGER, 'flow', 'SECRET-READ-ALLOW');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  try {
    assert.match(body(readRun(F.secret)).agent_message, /flow[\\/]SECRET-READ-ALLOW/, 'the denial names the receipt');
    fs.writeFileSync(receipt, `# allowed by the user in this session\n${F.secret}\n`);
    assert.equal(pre(`cat ${F.secret}`), 'allow', 'the listed file, on the shell');
    assert.equal(read(F.secret), 'allow', 'and on the read route');
    assert.equal(pre(`cat ${F.dotenv}`), 'rewrite', 'an unlisted file stays redacted');
    fs.writeFileSync(receipt, 'SENTRY_ACCESS_TOKEN\n');
    assert.equal(pre('echo $SENTRY_ACCESS_TOKEN'), 'allow', 'a listed variable NAME');
    assert.equal(pre('env'), 'rewrite', 'one name is not the whole environment');
    fs.writeFileSync(receipt, '*\n');
    assert.equal(shell('env'), 'allow', '* opens everything for the session');
    const old = (Date.now() - 9 * 3600 * 1000) / 1000; fs.utimesSync(receipt, old, old);
    const aged = body(readRun(F.secret));
    assert.equal(aged.permission, 'deny', 'a 9h-old receipt is absent');
    assert.match(aged.agent_message, /stale/, 'and the denial says so');
  } finally {
    fs.rmSync(receipt, { force: true });
  }
});

test('guard-secret-value --presence: set (N chars) or absent, never a value', () => {
  const r = cli('--presence', F.secret, 'SENTRY_ACCESS_TOKEN', 'SENTRY_SLUG', 'CONTEXT7_API_KEY');
  assert.equal(r.stdout, 'SENTRY_ACCESS_TOKEN=set (40 chars)\nSENTRY_SLUG=set (4 chars)\nCONTEXT7_API_KEY=absent\n');
  assert.equal(cli('--presence', F.crlf, 'API_KEY').stdout, 'API_KEY=set (6 chars)\n', 'a CRLF line counts no \\r');
});

test('guard-secret-value: an unparseable or non-shell payload is allowed, never crashed on', () => {
  const raw = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: ENV });
  assert.equal(body(raw).permission, 'allow');
  assert.equal(body(run({ hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: F.secret } })).permission, 'allow',
    'a tool this guard does not judge');
  assert.equal(pre(`cat ${F.secret}`, { CURSOR_PROJECT_DIR: '' }), 'rewrite', 'an absolute path needs no project dir');
});

// Ported with the peer stack's fix. Measured there (a .NET appsettings.Staging.json): the redacted view printed the
// Postgres and Redis passwords inside their connection strings and a Firebase PEM private key.
test('guard-secret-value: a password inside a connection string or URL, and a PEM private key, are credentials too', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvFAKEfakeFAKE\n-----END PRIVATE KEY-----\n';
  const pg = 'FakePgPass123';
  const app = w('appsettings.Staging.json', JSON.stringify({
    ConnectionStrings: { Postgres: `Host=db.test;Database=app;Password=${pg}`, Redis: 'cache.test:6379,password=FakeRedisPass456,ssl=True' },
    Firebase: { PrivateKey: pem },
  }, null, 2));
  const view = cli('--redacted', app).stdout;
  for (const v of [pg, 'FakeRedisPass456', 'MIIEvFAKEfakeFAKE']) assert.ok(!view.includes(v), `${v} never appears in the view`);
  assert.match(view, new RegExp(`Host=db\\.test;Database=app;Password=<set \\(${pg.length} chars\\)>`), 'the rest of the connection string stays readable');
  assert.match(view, /"PrivateKey": "<set \(\d+ chars\)>"/);
  assert.equal(read(w('conn.json', JSON.stringify({ ConnectionStrings: { Default: 'Server=x;Password=FakePw999' } }))), 'deny', 'a connection-string password alone');
  assert.equal(read(w('url.json', JSON.stringify({ Url: 'postgres://app:FakeUrlPw777@db.test/app' }))), 'deny', 'a URL userinfo password');
  assert.equal(read(w('noconn.json', JSON.stringify({ ConnectionStrings: { Default: 'Server=x;Trusted_Connection=True' }, Url: 'postgres://app:${env:PG_PW}@db/app' }))), 'allow', 'no live password');
});

test('guard-secret-value: a command that also CHANGES something is denied, never silently cut down to the redacted view', () => {
  const cmd = `F=${F.secret}\nN=$(grep -c SENTRY_SLUG "$F")\n[ "$N" = 1 ] && sed -i '' 's/acme/acme2/' "$F" && jq -r '.env.SENTRY_SLUG' "$F"`;
  assert.equal(pre(cmd), 'deny', 'preToolUse denies instead of rewriting');
  assert.equal(shell(cmd), 'deny', 'and so does beforeShellExecution');
  assert.match(preTool(cmd).stderr + preTool(cmd).stdout, /nothing ran/i);
  assert.equal(pre(`cat ${F.secret} && npm run build`), 'deny', 'a build after the dump');
  assert.equal(pre('echo $SENTRY_ACCESS_TOKEN && rm -rf gone'), 'deny', 'the variable rewrite drops steps the same way');
  assert.equal(pre(`cd ${ROOT} && ls && cat settings.json; echo done`), 'rewrite', 'read-only company is still rewritten');
});

test('guard-secret-value: a narrow read keeps its own filter over the redacted view', { skip: process.platform === 'win32' }, () => {
  const view = `node "${HOOK}" --redacted "${F.secret}"`;
  assert.equal(rewritten(`grep -n SENTRY_SLUG ${F.secret}`), `${view} --note-to-stderr | grep -n SENTRY_SLUG`);
  assert.equal(rewritten(`head -3 ${F.secret} | tail -1`), `${view} --note-to-stderr | head -3 | tail -1`);
  assert.equal(rewritten(`cat ${F.secret}`), view, 'a whole-file dump is still the whole view');
  const g = spawnSync('bash', ['-c', rewritten(`grep -n SENTRY ${F.secret}`)], { encoding: 'utf8', env: ENV });
  assert.match(g.stdout, /"SENTRY_ACCESS_TOKEN": "<set \(40 chars\)>"/);
  assert.ok(!(g.stdout + g.stderr).includes(FAKE_TOKEN));
  assert.match(g.stderr, /line numbers count the view/);
});
