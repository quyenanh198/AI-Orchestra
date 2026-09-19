import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative } from 'node:path';

/** Pure policy helpers for the agent tool runtime (no `vscode` import so they are unit-testable). */

const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;
const SENSITIVE = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.git\/config$/i,
  /(^|\/)\.(npmrc|netrc|pypirc)$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx)$/i,
];
// Writing here would let an agent rewrite workspace settings (re-enabling terminal/write access
// for itself) or repository metadata/hooks, so these are never agent-writable.
const PROTECTED_WRITE = [/(^|\/)\.git(\/|$)/i, /(^|\/)\.vscode(\/|$)/i, ...SENSITIVE];

export function assertPathAllowed(relativePath: string, access: 'read' | 'write'): void {
  const normalized = posix.normalize(relativePath.replace(/\\/g, '/'));
  if (ENV_TEMPLATE.test(normalized) && access === 'read') return;
  const blocked = (access === 'read' ? SENSITIVE : PROTECTED_WRITE).some(pattern => pattern.test(normalized));
  if (blocked) throw new Error(`AI Orchestra tool policy blocks ${access} access to ${relativePath}.`);
}

/** Follows symlinks: a link inside the workspace that points outside must not be readable/writable. */
export async function assertRealPathInside(root: string, target: string): Promise<void> {
  const realRoot = await realpath(root);
  let probe = target;
  for (;;) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
      continue;
    }
    const rel = relative(realRoot, real);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Resolved path is outside the active workspace.');
    return;
  }
}

const GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'add', 'commit']);
const GIT_DENIED_ARGS = /^(-c|--exec|--exec-path|--output|--ext-diff|--upload-pack|--receive-pack|--config-env)(=|$)/;
const NPM_SUBCOMMANDS = new Set(['test', 'run', 'run-script', 'ci', 'install', 'ls', 'outdated', 'audit']);
const NPM_DENIED_ARGS = /^(--prefix|--userconfig|--globalconfig|--registry|--script-shell)(=|$)/;

/**
 * The command allowlist alone is not a sandbox: `node -e`, `git -c core.sshCommand=...` and `npx <pkg>`
 * all execute arbitrary code. This constrains what each allowlisted binary may be asked to do.
 */
export function assertCommandArgs(command: string, args: string[]): void {
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Command arguments must be plain strings.');
  if (command === 'node') {
    const [script] = args;
    if (!script || script.startsWith('-')) throw new Error('node may only run a workspace script (flags such as -e/--eval/--require are blocked).');
    assertPathAllowed(script, 'read');
    return;
  }
  if (command === 'git') {
    if (!args[0] || !GIT_SUBCOMMANDS.has(args[0])) throw new Error(`git ${args[0] ?? ''} is not permitted for agents.`);
    if (args.some(arg => GIT_DENIED_ARGS.test(arg))) throw new Error('This git option is not permitted for agents.');
    return;
  }
  if (command === 'npm') {
    if (!args[0] || !NPM_SUBCOMMANDS.has(args[0])) throw new Error(`npm ${args[0] ?? ''} is not permitted for agents.`);
    if (args.some(arg => NPM_DENIED_ARGS.test(arg))) throw new Error('This npm option is not permitted for agents.');
    return;
  }
  throw new Error(`Command ${command} is not allowlisted.`);
}
