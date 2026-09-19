import { Message } from './types';

export interface GeminiTurn { role: 'user' | 'model'; parts: [{ text: string }] }

/**
 * Gemini's chat API wants system text in `systemInstruction` and strictly alternating user/model turns
 * that start with `user`. Sending a `system` message as a user turn (followed by the real user turn)
 * produces two consecutive user turns, which the API rejects.
 */
export function toGeminiPayload(messages: Message[]): { system: string; history: GeminiTurn[]; last: string } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns: GeminiTurn[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = turns[turns.length - 1];
    if (previous && previous.role === role) previous.parts[0].text += `\n\n${message.content}`;
    else turns.push({ role, parts: [{ text: message.content }] });
  }
  while (turns.length && turns[0].role === 'model') turns.shift();
  const final = turns[turns.length - 1];
  if (!final || final.role !== 'user') throw new Error('Gemini requests must end with a user message.');
  return { system, history: turns.slice(0, -1), last: final.parts[0].text };
}
