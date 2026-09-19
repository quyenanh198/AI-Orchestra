import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ai-orchestra.chatView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _onMessage: (message: any) => void
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            this._onMessage(data);
        });
        webviewView.onDidDispose(() => {
            if (this._view === webviewView) this._view = undefined;
        });
    }

    public postMessage(type: string, data: any) {
        if (this._view) {
            // A disposed webview rejects; a late goal result must not turn into an unhandled rejection.
            void Promise.resolve(this._view.webview.postMessage({ type, data })).catch(() => undefined);
        }
    }

    private _getHtmlForWebview(_webview: vscode.Webview) {
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>AI Orchestra Chat</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        margin: 0;
                        padding: 0;
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        box-sizing: border-box;
                    }
                    .header {
                        padding: 10px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .chat-container {
                        flex: 1;
                        overflow-y: auto;
                        padding: 10px;
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }
                    .message {
                        max-width: 85%;
                        padding: 10px;
                        border-radius: 8px;
                        word-wrap: break-word;
                    }
                    .message.user {
                        align-self: flex-end;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    .message.assistant {
                        align-self: flex-start;
                        background-color: var(--vscode-editorWidget-background);
                        border: 1px solid var(--vscode-widget-border);
                    }
                    .metadata {
                        font-size: 0.8em;
                        opacity: 0.7;
                        margin-top: 5px;
                        display: flex;
                        gap: 10px;
                    }
                    .input-area {
                        padding: 10px;
                        border-top: 1px solid var(--vscode-panel-border);
                        display: flex;
                        gap: 10px;
                    }
                    textarea {
                        flex: 1;
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                        resize: none;
                        padding: 8px;
                        font-family: var(--vscode-font-family);
                    }
                    button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 4px;
                        padding: 8px 16px;
                        cursor: pointer;
                    }
                    button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .loader {
                        display: none;
                        align-self: center;
                        margin: 10px 0;
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <select id="modelSelect" title="Executor agent" style="background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 4px;">
                        <option value="">Auto (supervisor decides)</option>
                    </select>
                    <span><button id="stopBtn" style="display:none">Stop</button> <button id="clearBtn" title="Forget the shared conversation context">Clear</button></span>
                </div>
                <div class="chat-container" id="chatContainer"></div>
                <div class="loader" id="loader">Thinking...</div>
                <div class="input-area">
                    <textarea id="messageInput" rows="3" placeholder="Ask something..."></textarea>
                    <button id="sendBtn">Send</button>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    const chatContainer = document.getElementById('chatContainer');
                    const messageInput = document.getElementById('messageInput');
                    const sendBtn = document.getElementById('sendBtn');
                    const clearBtn = document.getElementById('clearBtn');
                    const modelSelect = document.getElementById('modelSelect');
                    const loader = document.getElementById('loader');
                    const stopBtn = document.getElementById('stopBtn');

                    let currentAssistantMessageDiv = null;

                    sendBtn.addEventListener('click', () => {
                        const text = messageInput.value.trim();
                        if (text) {
                            addMessage(text, 'user');
                    vscode.postMessage({ type: 'sendMessage', text: text });
                            messageInput.value = '';
                            loader.style.display = 'block';
                            stopBtn.style.display = 'inline-block';
                            currentAssistantMessageDiv = null;
                        }
                    });

                    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

                    clearBtn.addEventListener('click', () => {
                        chatContainer.replaceChildren();
                        vscode.postMessage({ type: 'clearChat' });
                    });

                    modelSelect.addEventListener('change', () => {
                        vscode.postMessage({ type: 'pinAgent', agent: modelSelect.value });
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'appendChunk':
                                loader.style.display = 'none'; stopBtn.style.display = 'none';
                                if (!currentAssistantMessageDiv) {
                                    currentAssistantMessageDiv = createMessageDiv('', 'assistant');
                                    chatContainer.appendChild(currentAssistantMessageDiv);
                                }
                                const contentDiv = currentAssistantMessageDiv.querySelector('.content');
                                contentDiv.innerText += message.data.chunk;
                                chatContainer.scrollTop = chatContainer.scrollHeight;
                                break;
                            case 'messageComplete':
                                loader.style.display = 'none'; stopBtn.style.display = 'none';
                                if (!currentAssistantMessageDiv) {
                                    // Non-streaming: create the message div with content
                                    currentAssistantMessageDiv = createMessageDiv(message.data.content || '', 'assistant');
                                    chatContainer.appendChild(currentAssistantMessageDiv);
                                }
                                if (currentAssistantMessageDiv) {
                                    const metaDiv = document.createElement('div');
                                    metaDiv.className = 'metadata';
                                    // textContent, never innerHTML: model ids can come from a local Ollama server.
                                    const details = ['Agent: ' + message.data.agent, 'Why: ' + message.data.reason, 'Limit: ' + message.data.limit,
                                        'Model: ' + message.data.model, 'Tokens: ' + message.data.tokens];
                                    for (const text of details) {
                                        const span = document.createElement('span');
                                        span.textContent = text;
                                        metaDiv.appendChild(span);
                                    }
                                    currentAssistantMessageDiv.appendChild(metaDiv);
                                }
                                currentAssistantMessageDiv = null;
                                chatContainer.scrollTop = chatContainer.scrollHeight;
                                break;
                            case 'error':
                                loader.style.display = 'none'; stopBtn.style.display = 'none';
                                const errorDiv = createMessageDiv('⚠️ ' + (message.data.message || 'An error occurred'), 'assistant');
                                errorDiv.style.borderColor = 'var(--vscode-errorForeground)';
                                chatContainer.appendChild(errorDiv);
                                chatContainer.scrollTop = chatContainer.scrollHeight;
                                currentAssistantMessageDiv = null;
                                break;
                            case 'agentsUpdated': {
                                const auto = document.createElement('option');
                                auto.value = '';
                                auto.textContent = 'Auto (supervisor decides)';
                                modelSelect.replaceChildren(auto, ...message.data.agents.map(agent => {
                                    const option = document.createElement('option');
                                    option.value = agent.id;
                                    option.textContent = agent.label + ' - ' + agent.limit;
                                    return option;
                                }));
                                modelSelect.value = message.data.pinned || '';
                                break;
                            }
                        }
                    });

                    vscode.postMessage({ type: 'ready' });

                    function addMessage(text, role) {
                        const div = createMessageDiv(text, role);
                        chatContainer.appendChild(div);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }

                    function createMessageDiv(text, role) {
                        const div = document.createElement('div');
                        div.className = 'message ' + role;
                        const content = document.createElement('div');
                        content.className = 'content';
                        content.innerText = text;
                        div.appendChild(content);
                        return div;
                    }
                </script>
            </body>
            </html>`;
    }
}

function getNonce() {
    return randomBytes(24).toString('base64url');
}
