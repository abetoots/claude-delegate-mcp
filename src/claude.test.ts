import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildArgs, runClaude, type ClaudeOptions } from './claude.js';

const bin = resolve('test/fake-claude.mjs');
const opts: ClaudeOptions = { prompt: 'hello', model: 'opus', timeoutMs: 5000, cwd: process.cwd(), addDirs: [] };
const priorEnv = { ...process.env };
afterEach(() => { process.env = { ...priorEnv }; });

describe('Claude runner', () => {
  it('passes all fixed restricted flags and no forbidden flags', () => {
    expect(buildArgs(opts)).toEqual([
      '-p', '--restricted', '--tools', 'Read,Glob,Grep,WebSearch,WebFetch',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch',
      '--permission-prompts', 'none', '--model', 'opus',
    ]);
  });

  it('maps effort and each additional directory', () => {
    expect(buildArgs({ ...opts, effort: 'high', addDirs: ['/a', '/b'] }).slice(-6))
      .toEqual(['--effort', 'high', '--add-dir', '/a', '--add-dir', '/b']);
  });

  it('sends exactly one type-user message and strips inherited delegation markers', async () => {
    process.env.CLAUDECODE = 'secret';
    process.env.AI_DELEGATION_TICKET = 'secret';
    const result = await runClaude({ ...opts, prompt: 'inspect' }, { bin });
    expect(JSON.parse(result.response)).toEqual({
      stdin: '{"type":"user","message":{"role":"user","content":"inspect"}}\n',
      cwd: opts.cwd, depth: '1', claudecode: null, ticket: null,
    });
  });

  it('parses init model and final result fields', async () => {
    expect(await runClaude(opts, { bin })).toEqual({
      session_id: 'session-123', status: 'ok', response: 'answer', model_resolved: 'claude-opus-5-5',
      duration_seconds: 1.25, num_turns: 2, usage: { input_tokens: 3, output_tokens: 4 },
    });
  });

  it('reports result subtypes other than success as error', async () => {
    expect((await runClaude({ ...opts, prompt: 'fail' }, { bin })).status).toBe('error');
  });

  it('times out, returns a marked partial response, and waits for the child to exit', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'claude-test-')), 'pid');
    process.env.FAKE_CLAUDE_PID_FILE = pidFile;
    const result = await runClaude({ ...opts, prompt: 'hang', timeoutMs: 1000 }, { bin });
    expect(result.status).toBe('timeout');
    expect(result.response).toMatch(/partial/i);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('kills a child and rejects with cancelled when aborted', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'claude-test-')), 'pid');
    process.env.FAKE_CLAUDE_PID_FILE = pidFile;
    const controller = new AbortController();
    const run = runClaude({ ...opts, prompt: 'hang' }, { bin, signal: controller.signal });
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = Number(readFileSync(pidFile, 'utf8')); } catch { await new Promise(r => setTimeout(r, 20)); }
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports the exit code without leaking stderr when no result arrives', async () => {
    await expect(runClaude({ ...opts, prompt: 'crash' }, { bin })).rejects.toMatchObject({
      code: 'no-result', message: expect.stringMatching(/code 2/),
    });
    await expect(runClaude({ ...opts, prompt: 'crash' }, { bin })).rejects.not.toThrow('sensitive stderr');
  });
});
