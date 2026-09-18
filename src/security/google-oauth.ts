import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { OAuth2Client } from 'google-auth-library';

interface StoredGoogleOAuth {
  clientId: string;
  clientSecret: string;
  projectId: string;
  refreshToken: string;
}

const SECRET_KEY = 'ai-orchestra.gemini.oauth';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever',
];

export class GoogleOAuthManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  public async isConfigured(): Promise<boolean> { return !!(await this.load()); }

  public async signIn(clientId: string, clientSecret: string, projectId: string): Promise<void> {
    const state = crypto.randomBytes(24).toString('hex');
    const result = await this.listenForCallback();
    const client = new OAuth2Client(clientId, clientSecret, result.redirectUri);
    const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const code = await result.waitForCode(state);
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Revoke the app grant and try again.');
    const stored: StoredGoogleOAuth = { clientId, clientSecret, projectId, refreshToken: tokens.refresh_token };
    await this.secrets.store(SECRET_KEY, JSON.stringify(stored));
  }

  public async signOut(): Promise<void> { await this.secrets.delete(SECRET_KEY); }

  public async getRequestHeaders(): Promise<Record<string, string>> {
    const stored = await this.load();
    if (!stored) throw new Error('Gemini OAuth is not configured.');
    const client = new OAuth2Client(stored.clientId, stored.clientSecret);
    client.setCredentials({ refresh_token: stored.refreshToken });
    const token = await client.getAccessToken();
    if (!token.token) throw new Error('Google OAuth access token could not be refreshed.');
    return { Authorization: `Bearer ${token.token}`, 'x-goog-user-project': stored.projectId };
  }

  private async load(): Promise<StoredGoogleOAuth | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as StoredGoogleOAuth; } catch { return undefined; }
  }

  private async listenForCallback(): Promise<{ redirectUri: string; waitForCode: (expectedState: string) => Promise<string> }> {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate OAuth callback port.');
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    return {
      redirectUri,
      waitForCode: (expectedState: string) => new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => { server.close(); reject(new Error('Google OAuth login timed out.')); }, 180_000);
        server.once('request', (request, response) => {
          clearTimeout(timeout);
          const url = new URL(request.url || '/', redirectUri);
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');
          response.writeHead(code && state === expectedState ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(code ? 'AI Orchestra login complete. You can close this tab.' : 'AI Orchestra login failed.');
          server.close();
          if (error) reject(new Error(`Google OAuth failed: ${error}`));
          else if (!code || state !== expectedState) reject(new Error('Google OAuth callback was invalid.'));
          else resolve(code);
        });
      }),
    };
  }
}
