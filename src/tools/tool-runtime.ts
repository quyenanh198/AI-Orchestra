import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentCapability, AgentDefinition } from '../agents/types';

const execFileAsync = promisify(execFile);
const ALLOWED_COMMANDS = new Set(['git', 'npm', 'npx', 'node']);

export class ToolRuntime {
  private require(agent: AgentDefinition, capability: AgentCapability): void {
    if (!agent.capabilities.includes(capability)) throw new Error(`Agent ${agent.id} lacks ${capability}.`);
  }

  public async readFile(agent: AgentDefinition, uri: vscode.Uri): Promise<string> {
    this.require(agent, 'workspace.read');
    if (!vscode.workspace.getWorkspaceFolder(uri)) throw new Error('Reads outside the active workspace are forbidden.');
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  }

  public async writeFile(agent: AgentDefinition, uri: vscode.Uri, content: string): Promise<void> {
    this.require(agent, 'workspace.write');
    const allowed = vscode.workspace.getConfiguration('ai-orchestra.tools').get('allowWorkspaceWrite', false);
    if (!allowed) throw new Error('Workspace writes are disabled in AI Orchestra settings.');
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) throw new Error('Writes outside the active workspace are forbidden.');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  public async execute(agent: AgentDefinition, command: string, args: string[], cwd: string): Promise<string> {
    this.require(agent, 'terminal.execute');
    const allowed = vscode.workspace.getConfiguration('ai-orchestra.tools').get('allowTerminal', false);
    if (!allowed) throw new Error('Terminal execution is disabled in AI Orchestra settings.');
    if (!ALLOWED_COMMANDS.has(command)) throw new Error(`Command ${command} is not allowlisted.`);
    const folder = vscode.workspace.workspaceFolders?.find(item => cwd === item.uri.fsPath || cwd.startsWith(`${item.uri.fsPath}${process.platform === 'win32' ? '\\' : '/'}`));
    if (!folder) throw new Error('Terminal working directory must be inside an active workspace.');
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, timeout: 120_000, windowsHide: true });
    return `${stdout}${stderr}`;
  }

  public async executeCall(agent: AgentDefinition, call: { tool: string; path?: string; content?: string; command?: string; args?: string[] }): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error('No workspace folder is open.');
    if (call.tool === 'read_file' && call.path) return this.readFile(agent, vscode.Uri.joinPath(root, call.path));
    if (call.tool === 'write_file' && call.path && call.content !== undefined) {
      await this.writeFile(agent, vscode.Uri.joinPath(root, call.path), call.content);
      return `Wrote ${call.path}`;
    }
    if (call.tool === 'execute' && call.command) return this.execute(agent, call.command, call.args || [], root.fsPath);
    throw new Error(`Unsupported or malformed tool call: ${call.tool}`);
  }
}
