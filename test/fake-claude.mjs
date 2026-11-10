#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const message = JSON.parse(stdin.trim());
if (message.type !== 'user') process.exit(0);
const prompt = message.message.content;
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
if (prompt === 'crash') {
  process.stderr.write('sensitive stderr');
  process.exit(2);
}
emit({ type: 'system', subtype: 'init', session_id: 'session-123', model: 'claude-opus-5-5', tools: [], mcp_servers: [] });
if (prompt === 'hang') {
  if (process.env.FAKE_CLAUDE_PID_FILE) writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer' }] } });
  setInterval(() => {}, 60_000);
} else {
  const response = prompt === 'inspect' ? JSON.stringify({
    stdin, cwd: process.cwd(), depth: process.env.CLAUDE_DELEGATE_DEPTH ?? null,
    claudecode: process.env.CLAUDECODE ?? null, ticket: process.env.AI_DELEGATION_TICKET ?? null,
  }) : 'answer';
  emit({ type: 'result', subtype: prompt === 'fail' ? 'error_during_execution' : 'success', result: response,
    session_id: 'session-123', num_turns: 2, duration_ms: 1250,
    usage: { input_tokens: 3, output_tokens: 4 }, is_error: prompt === 'fail' || prompt === 'api-error' });
}
