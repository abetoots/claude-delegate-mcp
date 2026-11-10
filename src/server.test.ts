import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './server.js';
import { TicketClient } from './ticket-client.js';
import { GrantClient } from './grant-client.js';

let dir: string, project: string, receipt: string, settings: string;
let client: Client;
let ticket: any, tickets: any, grants: any, run: any;
const result = { session_id: 's', status: 'ok', response: 'answer', model_resolved: 'resolved', duration_seconds: 1, num_turns: 1 };
const decision = { allowed: true, reason: 'allowed', effectiveHash: 'hash' };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'delegate-'));
  project = join(dir, 'project'); mkdirSync(project);
  receipt = join(dir, 'state', 'receipts.jsonl'); settings = join(dir, 'settings.json');
  process.env.AI_DELEGATION_TICKET = 'a'.repeat(32); delete process.env.CLAUDE_DELEGATE_DEPTH;
  ticket = { allowed: true, reason: 'allowed', grant_id: null, parent_harness: 'codex', project: 'p', dispatch_id: 'd', effective_hash: 'hash', revision: null, cwd: project, add_dirs: [], remaining: 4 };
  tickets = { show: vi.fn(async () => ticket), consume: vi.fn(async () => ({ ...ticket, remaining: 3 })) };
  grants = { check: vi.fn(async () => decision) };
  run = vi.fn(async () => result);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ tickets, grants, runClaude: run, receiptPath: receipt, settingsPath: settings, keepaliveMs: 10 }).connect(b);
  client = new Client({ name: 'test', version: '1' }); await client.connect(a);
});
afterEach(async () => { await client.close(); delete process.env.AI_DELEGATION_TICKET; delete process.env.CLAUDE_DELEGATE_DEPTH; });
const call = (args: Record<string, unknown> = {}) => client.callTool({ name: 'claude', arguments: { prompt: 'secret prompt', ...args } });
const lastReceipt = () => JSON.parse(readFileSync(receipt, 'utf8').trim().split('\n').at(-1)!);

describe('governed delegation', () => {
  it.each([['no-ticket', () => { delete process.env.AI_DELEGATION_TICKET; }], ['depth', () => { process.env.CLAUDE_DELEGATE_DEPTH = '1'; }]])('refuses %s before reading ticket', async (reason, setup) => {
    setup(); expect((await call()).isError).toBe(true); expect(tickets.show).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(lastReceipt()).toMatchObject({ status: 'refused', reason, ticket_hash: null, parent_harness: null, dispatch_id: null, project: null, cwd: null });
  });
  it.each(['unknown', 'expired', 'budget', 'store-unreadable'])('refuses ticket denial %s', async reason => {
    tickets.show.mockResolvedValue({ allowed: false, reason }); expect((await call()).isError).toBe(true); expect(run).not.toHaveBeenCalled(); expect(lastReceipt().reason).toBe(reason);
  });
  it.each(['cwd', 'add_dirs'])('refuses outside %s without consuming', async key => {
    const args = key === 'cwd' ? { cwd: dir } : { add_dirs: [dir] };
    expect((await call(args)).isError).toBe(true); expect(tickets.consume).not.toHaveBeenCalled(); expect(lastReceipt().reason).toBe('outside-parent');
  });
  it('refuses a symlink resolving outside', async () => {
    symlinkSync(dir, join(project, 'escape')); expect((await call({ cwd: 'escape' })).isError).toBe(true); expect(tickets.consume).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'revision-changed', 'prompt-like text'])('maps parent denial %s safely', async reason => {
    grants.check.mockResolvedValue({ ...decision, allowed: false, reason }); expect((await call()).isError).toBe(true); expect(tickets.consume).not.toHaveBeenCalled();
    expect(lastReceipt().reason).toBe(reason === 'prompt-like text' ? 'checker-failed' : `parent-refused:${reason}`);
  });
  it('refuses checker failure and scope change', async () => {
    grants.check.mockRejectedValueOnce(new Error('secret')); expect((await call()).isError).toBe(true); expect(lastReceipt().reason).toBe('checker-failed');
    grants.check.mockResolvedValueOnce({ ...decision, effectiveHash: 'different' }); expect((await call()).isError).toBe(true); expect(lastReceipt().reason).toBe('scope-changed'); expect(tickets.consume).not.toHaveBeenCalled();
  });
  it('checks the bound parent then runs once with resolved cwd and records an ok receipt', async () => {
    mkdirSync(join(project, 'sub')); const response = await call({ cwd: 'sub' });
    expect(grants.check).toHaveBeenCalledWith({ phase: 'resume', harness: 'codex', cwd: project, addDirs: [], grantId: null, revision: null, boundProject: 'p' });
    expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0][0]).toMatchObject({ cwd: join(project, 'sub'), model: 'opus', timeoutMs: 1200000 });
    expect(response.structuredContent).toMatchObject({ status: 'ok', response: 'answer', model_resolved: 'resolved', ticket_remaining: 3 });
    expect(lastReceipt()).toMatchObject({ status: 'ok', reason: null }); expect(readFileSync(receipt, 'utf8')).not.toContain('secret prompt');
  });
  it('reads model settings per call', async () => {
    writeFileSync(settings, JSON.stringify({ model: 'configured' })); await call(); expect(run.mock.calls[0][0]).toMatchObject({ model: 'configured', cwd: project });
    await call({ model: 'explicit' }); expect(run.mock.calls[1][0].model).toBe('explicit');
  });
  it('rejects invalid timeout before ticket read', async () => {
    expect((await call({ timeout: '31m' })).isError).toBe(true); expect(lastReceipt().reason).toBe('bad-request'); expect(tickets.show).not.toHaveBeenCalled();
  });
  it.each(['consume-indeterminate', 'store-unreadable', 'budget'])('refuses consume failure %s', async reason => {
    tickets.consume.mockResolvedValue({ allowed: false, reason }); expect((await call()).isError).toBe(true); expect(run).not.toHaveBeenCalled(); expect(lastReceipt().reason).toBe(reason);
  });
  it.each([['cancelled', 'cancelled'], ['no-result', 'no-result'], ['other', 'child-error']])('records child rejection %s', async (code, reason) => {
    run.mockRejectedValue(Object.assign(new Error('secret'), { code })); expect((await call()).isError).toBe(true); expect(lastReceipt()).toMatchObject({ status: 'error', reason });
  });
  it.each([['error', 'child-error'], ['timeout', 'timeout']])('reports child %s as error', async (status, reason) => {
    run.mockResolvedValue({ ...result, status }); expect((await call()).isError).toBe(true); expect(lastReceipt()).toMatchObject({ status, reason });
  });
  it('refuses when the real ticket helper exits 3', async () => {
    const helper = join(dir, 'helper'); writeFileSync(helper, '#!/usr/bin/env node\nprocess.exit(3)\n'); chmodSync(helper, 0o755);
    const actual = new TicketClient(helper); tickets.show.mockImplementation(actual.show.bind(actual));
    expect((await call()).isError).toBe(true); expect(lastReceipt().reason).toBe('store-unreadable'); expect(run).not.toHaveBeenCalled();
  });
  it('refuses a missing real checker without consuming', async () => {
    grants.check.mockImplementation(new GrantClient(join(dir, 'missing')).check.bind(new GrantClient(join(dir, 'missing'))));
    expect((await call()).isError).toBe(true); expect(lastReceipt().reason).toBe('checker-failed'); expect(tickets.consume).not.toHaveBeenCalled();
  });
  it.each(['process.exit(1)', "console.log('garbage')"])('refuses when a real consume helper loses its reply: %s', async finish => {
    const helper = join(dir, 'helper'); const marker = join(dir, 'consumed');
    writeFileSync(helper, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'decremented'); ${finish}\n`); chmodSync(helper, 0o755);
    const actual = new TicketClient(helper); tickets.consume.mockImplementation(actual.consume.bind(actual));
    expect((await call()).isError).toBe(true); expect(readFileSync(marker, 'utf8')).toBe('decremented');
    expect(lastReceipt().reason).toBe('consume-indeterminate'); expect(run).not.toHaveBeenCalled();
  });
  it('sends progress while running', async () => {
    run.mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return result; });
    let progress = 0; await client.callTool({ name: 'claude', arguments: { prompt: 'hi' } }, undefined, { onprogress: () => { progress++; } }); expect(progress).toBeGreaterThan(0);
  });
});
