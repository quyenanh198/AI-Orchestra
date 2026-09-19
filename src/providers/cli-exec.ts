import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Launching CLIs on Windows. npm installs `codex`, `claude`, `npx`... as `.cmd` shims, and since the
 * CVE-2024-27980 fix Node refuses to spawn a `.cmd`/`.bat` without a shell (`spawn EINVAL`). Adding `shell: true` is
 * not an option: the prompt is arbitrary text and cmd.exe would interpret `& | ^ %`. Instead the shim is read and the
 * real target (a native `.exe`, or a script run by `node`) is launched directly, with no shell involved.
 */
export interface Launch { executable: string; prefix: string[]; env?: Record<string, string> }
export interface ShimTarget { kind: 'exe' | 'node'; target: string }

const TARGET_EXT = /\.(exe|cjs|mjs|js)$/i;

/** Understands the shim layouts npm/cmd-shim produce: direct `.exe`, `node script.js`, and npm 11's `%NODE_EXE%` form. */
export function parseCmdShim(text: string, shimPath: string): ShimTarget | undefined {
  const dp0 = `${win32.dirname(shimPath)}\\`;
  const vars = new Map<string, string>();
  // The first definition is the default. npm 11 shims redefine a variable later, inside an IF/FOR block, to an
  // "npm prefix" override that only resolves at run time (`%%F`); letting that win would make the shim unresolvable.
  for (const match of text.matchAll(/^\s*set\s+"?([A-Za-z_]\w*)=(.*?)"?\s*$/gim)) {
    if (!vars.has(match[1].toLowerCase())) vars.set(match[1].toLowerCase(), match[2]);
  }
  const expand = (value: string, depth = 0): string => value
    .replace(/%~?dp0%?/gi, dp0)
    .replace(/%([A-Za-z_]\w*)%/g, (whole, name: string) => (vars.has(name.toLowerCase()) && depth < 4 ? expand(vars.get(name.toLowerCase()) as string, depth + 1) : whole));
  const invoking = text.split(/\r?\n/).filter(line => line.includes('%*')).pop();
  if (!invoking) return undefined;
  for (const token of invoking.matchAll(/"([^"]+)"/g)) {
    const path = win32.normalize(expand(token[1]));
    if (path.includes('%') || !TARGET_EXT.test(path)) continue;
    if (/^node(\.exe)?$/i.test(win32.basename(path))) continue; // the interpreter, not the thing being run
    return { kind: win32.extname(path).toLowerCase() === '.exe' ? 'exe' : 'node', target: path };
  }
  return undefined;
}

/** First match on PATH. On Windows only `.exe` unless `allowShims` (then `.cmd`/`.bat` too, to be resolved by `resolveLaunch`). */
async function locate(name: string, allowShims = false): Promise<string | undefined> {
  const accepted = allowShims ? /\.(exe|cmd|bat)$/i : /\.exe$/i;
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { timeout: 5_000, windowsHide: true });
    return stdout.split(/\r?\n/).map(line => line.trim()).find(line => line && (process.platform !== 'win32' || accepted.test(line)));
  } catch { return undefined; }
}

async function findNode(shimDir: string): Promise<{ executable: string; env?: Record<string, string> }> {
  const sibling = win32.join(shimDir, 'node.exe');
  if (existsSync(sibling)) return { executable: sibling };
  const onPath = await locate('node');
  if (onPath) return { executable: onPath };
  // VS Code ships its own Node runtime inside Electron; this is the last resort, not the first choice.
  return { executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Turns whatever `where`/`which` returned into something `execFile` can spawn without a shell. */
export async function resolveLaunch(executable: string): Promise<Launch> {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { executable, prefix: [] };
  let text: string;
  try { text = await readFile(executable, 'utf8'); }
  catch { throw new Error(`Cannot read ${win32.basename(executable)} to launch it without a shell.`); }
  const target = parseCmdShim(text, executable);
  if (!target || !existsSync(target.target)) {
    throw new Error(`${win32.basename(executable)} is an npm shim this extension cannot launch safely. Reinstall the CLI with its official installer or add its .exe to PATH.`);
  }
  if (target.kind === 'exe') return { executable: target.target, prefix: [] };
  const node = await findNode(win32.dirname(executable));
  return { executable: node.executable, prefix: [target.target], env: node.env };
}

export interface RunOptions { cwd?: string; timeout: number; signal?: AbortSignal; input?: string; maxBuffer?: number }

/** Runs a resolved CLI. The prompt, when given, goes over stdin so it never touches the command line. */
export async function runProcess(launch: Launch, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  const child = execFileAsync(launch.executable, [...launch.prefix, ...args], {
    cwd: options.cwd, timeout: options.timeout, signal: options.signal, windowsHide: true,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    env: launch.env ? { ...process.env, ...launch.env } : process.env,
  });
  // Always close stdin: some CLIs wait for EOF before answering in print mode.
  child.child.stdin?.on('error', () => undefined);
  child.child.stdin?.end(options.input ?? '');
  return child;
}

/** Absolute path of a program on PATH, never a bare name that Windows would resolve against the current directory. */
export { locate as locateProgram };
