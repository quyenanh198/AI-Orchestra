import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { locateProgram, parseCmdShim, resolveLaunch, runProcess } from '../providers/cli-exec';
import { describeCliFailure, extractCliError } from '../providers/cli-status';
import { isRateLimitMessage, parseRetryDelayMs } from '../orchestrator/limit-tracker';

const CLAUDE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;
const CODEX_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;
const NPM_11_SHIM = `:: Created by npm, please don't edit manually.
@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (
  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"
)

"%NODE_EXE%" "%NPM_CLI_JS%" %*
`;

test('npm .cmd shims resolve to the real target without a shell', () => {
  assert.deepEqual(parseCmdShim(CLAUDE_SHIM, 'C:\\tools\\node\\claude.cmd'),
    { kind: 'exe', target: 'C:\\tools\\node\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe' });
  assert.deepEqual(parseCmdShim(CODEX_SHIM, 'C:\\tools\\node\\codex.cmd'),
    { kind: 'node', target: 'C:\\tools\\node\\node_modules\\@openai\\codex\\bin\\codex.js' });
  assert.deepEqual(parseCmdShim(NPM_11_SHIM, 'C:\\tools\\node\\npm.cmd'),
    { kind: 'node', target: 'C:\\tools\\node\\node_modules\\npm\\bin\\npm-cli.js' }, 'the npm-prefix helper script is not mistaken for the target');
  assert.equal(parseCmdShim('@echo off\r\necho hello\r\n', 'C:\\x\\y.cmd'), undefined, 'a batch file that is not a shim is refused, not guessed');
  assert.equal(parseCmdShim('"%UNDEFINED%\\a.js" %*', 'C:\\x\\y.cmd'), undefined, 'unresolved variables are refused');
});

test('real executables are launched as they are', async () => {
  assert.deepEqual(await resolveLaunch(process.execPath), { executable: process.execPath, prefix: [] });
});

test('a prompt travels over stdin untouched: shell metacharacters, unicode and sizes beyond the Windows command-line limit', async () => {
  const echo = { executable: process.execPath, prefix: ['-e', 'process.stdin.pipe(process.stdout)'] };
  const nasty = 'h\u00e9llo "quoted" & | ^ % !VAR! $(x) `y` <>\r\nsecond line';
  assert.equal((await runProcess(echo, [], { timeout: 15_000, input: nasty })).stdout, nasty);
  const big = 'x'.repeat(300_000); // a command line cannot carry this (Windows caps it near 32,000 characters)
  assert.equal((await runProcess(echo, [], { timeout: 30_000, input: big })).stdout.length, big.length);
  assert.equal((await runProcess(echo, [], { timeout: 15_000 })).stdout, '', 'stdin is closed when there is no input');
});

test('a hung CLI is killed by the timeout and cancellation is honoured', async () => {
  const hang = { executable: process.execPath, prefix: ['-e', 'setInterval(() => {}, 1000)'] };
  await assert.rejects(runProcess(hang, [], { timeout: 300 }), (error: Error & { killed?: boolean }) => error.killed === true);
  const controller = new AbortController();
  const pending = runProcess(hang, [], { timeout: 20_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
});

const onWindows = process.platform === 'win32';

test('on Windows, Node cannot spawn a .cmd directly, but the resolved launch works', { skip: !onWindows }, async () => {
  const npm = await locateProgram('npm', true);
  if (!npm || !/\.cmd$/i.test(npm)) return; // no npm shim on this machine
  // Depending on the Node version the EINVAL is thrown synchronously or returned as a rejection; the async wrapper covers both.
  await assert.rejects(async () => promisify(execFile)(npm, ['--version']), (error: NodeJS.ErrnoException) => error.code === 'EINVAL',
    'the bug being fixed: a direct spawn of a .cmd fails with EINVAL');
  const launch = await resolveLaunch(npm);
  assert.notEqual(launch.executable, npm);
  const { stdout } = await runProcess(launch, ['--version'], { timeout: 30_000 });
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('on Windows, every installed CLI shim on PATH can actually be launched', { skip: !onWindows }, async () => {
  for (const name of ['claude', 'codex', 'grok', 'npx']) {
    const found = await locateProgram(name, true);
    if (!found) continue;
    const launch = await resolveLaunch(found);
    const { stdout, stderr } = await runProcess(launch, ['--version'], { timeout: 60_000 });
    assert.ok(`${stdout}${stderr}`.trim().length > 0, `${name} --version printed nothing`);
  }
});

test('a rate limit printed on stdout is extracted, so the supervisor can pause that agent', () => {
  const codex = [
    '{"type":"thread.started","thread_id":"01a0"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:39 PM."}',
    '{"type":"turn.failed","error":{"message":"You\u2019ve hit your usage limit. try again at 6:39 PM."}}',
  ].join('\n');
  const message = extractCliError(codex) ?? '';
  assert.match(message, /usage limit/);
  assert.equal(isRateLimitMessage(message), true);
  assert.equal(extractCliError('{"is_error":true,"result":"Claude AI usage limit reached"}'), 'Claude AI usage limit reached');
  assert.equal(extractCliError('{"is_error":true,"subtype":"error_max_turns","errors":["Reached maximum number of turns (1)"]}'), 'Reached maximum number of turns (1)',
    'a Claude failure with no result text still says why it failed');
  assert.equal(extractCliError('plain text, no json'), undefined);

  const failure = Object.assign(new Error('Command failed: codex exec ... SECRET-PROMPT'), { code: 1, stderr: '', stdout: codex });
  const described = describeCliFailure('Codex', failure);
  assert.match(described, /usage limit/);
  assert.doesNotMatch(described, /SECRET-PROMPT/);
});

test('"try again at 6:39 PM" becomes a real cooldown instead of the 15-minute default', () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 8, 18, hours, minutes, 0, 0).getTime();
  assert.equal(parseRetryDelayMs('try again at 6:39 PM.', at(17, 0)), 99 * 60_000);
  assert.equal(parseRetryDelayMs('try again at 6:39 PM.', at(19, 0)), (23 * 60 + 39) * 60_000, 'a time that already passed today means tomorrow');
  assert.equal(parseRetryDelayMs('Try again at 12:05 AM', at(23, 0)), 65 * 60_000);
  assert.equal(parseRetryDelayMs('resets at 18:39', at(17, 0)), 99 * 60_000, '24-hour clocks work too');
  assert.equal(parseRetryDelayMs('try again in 2 hours', at(9, 0)), 2 * 3_600_000, 'relative hints still win when there is no clock time');
  assert.equal(parseRetryDelayMs('no hint at all', at(9, 0)), 15 * 60_000);
});
