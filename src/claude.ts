import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ClaudeOptions {
  prompt: string;
  model: string;
  effort?: string;
  timeoutMs: number;
  cwd: string;
  addDirs: string[];
}

export interface ClaudeResult {
  session_id: string;
  status: 'ok' | 'error' | 'timeout';
  response: string;
  model_resolved: string;
  duration_seconds: number;
  num_turns: number;
  usage?: Record<string, unknown>;
}

export interface RunHooks {
  bin?: string;
  signal?: AbortSignal;
}

export function buildArgs(opts: ClaudeOptions): string[] {
  const tools = 'Read,Glob,Grep,WebSearch,WebFetch';
  const args = [
    '-p', '--restricted', '--tools', tools, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--allowedTools', tools, '--permission-prompts', 'none', '--model', opts.model,
  ];
  if (opts.effort) args.push('--effort', opts.effort);
  for (const dir of opts.addDirs) args.push('--add-dir', dir);
  return args;
}

function cancelled(): Error & { code: string } {
  return Object.assign(new Error('Claude run cancelled.'), { code: 'cancelled' });
}

export function runClaude(opts: ClaudeOptions, hooks: RunHooks = {}): Promise<ClaudeResult> {
  if (hooks.signal?.aborted) return Promise.reject(cancelled());
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_DELEGATE_DEPTH: '1' };
  delete env.CLAUDECODE;
  delete env.AI_DELEGATION_TICKET;

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(hooks.bin ?? 'claude', buildArgs(opts), { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let aborted = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let model = '';
    let session = '';
    let partial = '';
    let result: ClaudeResult | undefined;
    const abort = () => { aborted = true; child.kill('SIGKILL'); };
    hooks.signal?.addEventListener('abort', abort, { once: true });
    if (hooks.signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: opts.prompt } }) + '\n');
    child.stderr.resume();
    child.on('error', (error) => { spawnError = error; });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'system' && event.subtype === 'init') {
        model = event.model ?? '';
        session = event.session_id ?? '';
      } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        partial += event.message.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('');
      } else if (event.type === 'result') {
        result = {
          session_id: event.session_id ?? '', status: event.subtype === 'success' ? 'ok' : 'error',
          response: event.result ?? '', model_resolved: model, duration_seconds: (event.duration_ms ?? 0) / 1000,
          num_turns: event.num_turns ?? 0, ...(event.usage === undefined ? {} : { usage: event.usage }),
        };
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      hooks.signal?.removeEventListener('abort', abort);
      if (aborted) return reject(cancelled());
      if (timedOut) return resolve({
        session_id: session, status: 'timeout', response: `[Partial response; timed out]${partial ? `\n${partial}` : ''}`,
        model_resolved: model, duration_seconds: (Date.now() - started) / 1000, num_turns: 0,
      });
      if (spawnError) return reject(spawnError);
      if (result) return resolve(result);
      reject(Object.assign(new Error(`Claude exited with code ${code} without a result.`), { code: 'no-result' }));
    });
  });
}
