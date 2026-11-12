import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'delegate-')));
  project = join(dir, 'project'); mkdirSync(project);
  receipt = join(dir, 'state', 'receipts.jsonl'); settings = join(dir, 'settings.json');
  process.env.AI_DELEGATION_TICKET = 'a'.repeat(32); delete process.env.CLAUDE_DELEGATE_DEPTH;
  ticket = { allowed: true, reason: 'allowed', grant_id: null, parent_harness: 'codex', project: 'p', dispatch_id: 'd', effective_hash: 'hash', revision: null, cwd: project, add_dirs: [], remaining: 4, expires_at: '2099-01-01T00:00:00Z' };
  tickets = { show: vi.fn(async () => ticket), consume: vi.fn(async () => ({ ...ticket, remaining: 3 })) };
  grants = { check: vi.fn(async () => decision) };
  run = vi.fn(async () => result);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ tickets, grants, runClaude: run, receiptPath: receipt, settingsPath: settings, keepaliveMs: 10 }).connect(b);
  client = new Client({ name: 'test', version: '1' }); await client.connect(a);
});
afterEach(async () => {
  if (existsSync(receipt)) for (const line of readFileSync(receipt, 'utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    expect(line).not.toContain('secret');
    expect(line).not.toContain('secret prompt');
    expect(Object.keys(row).sort()).toEqual(['ts', 'status', 'reason', 'ticket_hash', 'parent_harness', 'dispatch_id', 'project', 'cwd', 'child_cwd', 'child_add_dirs', ...(row.status === 'ok' || row.status === 'timeout' || (row.status === 'error' && 'model_resolved' in row) ? ['model_resolved', 'duration_seconds'] : [])].sort());
  }
  await client.close(); delete process.env.AI_DELEGATION_TICKET; delete process.env.CLAUDE_DELEGATE_DEPTH; });
const call = (args: Record<string, unknown> = {}) => client.callTool({ name: 'claude', arguments: { prompt: 'secret prompt', ...args } });
const lastReceipt = () => JSON.parse(readFileSync(receipt, 'utf8').trim().split('\n').at(-1)!);
const expectRefusedClean = (response: any, reason: string) => { expect(response.isError).toBe(true); expect(lastReceipt().reason).toBe(reason); expect(run).not.toHaveBeenCalled(); expect(tickets.consume).not.toHaveBeenCalled(); };

describe('governed delegation', () => {
  it('tools/list advertises prompt as required and documents timeout', async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find(item => item.name === 'claude')!;
    expect(tool.description).toMatch(/one-shot.*read-only/i);
    expect(tool.inputSchema.required).toContain('prompt');
    const properties = tool.inputSchema.properties as Record<string, { description: string }>;
    expect(properties.prompt.description).toMatch(/required/i);
    expect(properties.timeout.description).toMatch(/20m/);
    expect(properties.timeout.description).toMatch(/30m/);
    expect(properties.timeout.description).toContain(String.raw`^\d+(s|m)$`);
    for (const field of ['model', 'effort', 'cwd', 'add_dirs']) expect(properties[field].description).toBeTruthy();
  });
  it.each([['no-ticket', () => { delete process.env.AI_DELEGATION_TICKET; }], ['depth', () => { process.env.CLAUDE_DELEGATE_DEPTH = '1'; }]])('refuses %s before reading ticket', async (reason, setup) => {
    setup(); expectRefusedClean(await call(), reason); expect(tickets.show).not.toHaveBeenCalled();
    expect(lastReceipt()).toMatchObject({ status: 'refused', reason, ticket_hash: null, parent_harness: null, dispatch_id: null, project: null, cwd: null });
  });
  it.each(['unknown', 'expired', 'budget', 'store-unreadable'])('refuses ticket denial %s', async reason => {
    tickets.show.mockResolvedValue({ allowed: false, reason }); expectRefusedClean(await call(), reason);
  });
  it('refuses a failed show helper', async () => {
    tickets.show.mockRejectedValue(new Error('secret')); expectRefusedClean(await call(), 'store-unreadable');
  });
  it.each(['cwd', 'add_dirs'])('refuses outside %s without consuming', async key => {
    const evil = project + '-evil'; mkdirSync(evil);
    const args = key === 'cwd' ? { cwd: evil } : { add_dirs: [evil] };
    expectRefusedClean(await call(args), 'outside-parent');
  });
  it('refuses a symlink resolving outside', async () => {
    symlinkSync(dir, join(project, 'escape')); expectRefusedClean(await call({ cwd: 'escape' }), 'outside-parent');
  });
  it.each(['revoked', 'revision-changed', 'prompt-like text'])('maps parent denial %s safely', async reason => {
    grants.check.mockResolvedValue({ ...decision, allowed: false, reason }); expectRefusedClean(await call(), reason === 'prompt-like text' ? 'checker-failed' : `parent-refused:${reason}`);
  });
  it('refuses checker failure and scope change', async () => {
    grants.check.mockRejectedValueOnce(new Error('secret')); expectRefusedClean(await call(), 'checker-failed');
    grants.check.mockResolvedValueOnce({ ...decision, effectiveHash: 'different' }); expectRefusedClean(await call(), 'scope-changed');
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
  it('records a missing prompt as a bad request', async () => {
    const result = await client.callTool({ name: 'claude', arguments: {} });
    expectRefusedClean(result, 'bad-request'); expect(tickets.show).not.toHaveBeenCalled();
  });
  it('rejects invalid timeout before ticket read', async () => {
    expectRefusedClean(await call({ timeout: '31m' }), 'bad-request'); expect(tickets.show).not.toHaveBeenCalled();
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
    expectRefusedClean(await call(), 'store-unreadable');
  });
  it('refuses a missing real checker without consuming', async () => {
    grants.check.mockImplementation(new GrantClient(join(dir, 'missing')).check.bind(new GrantClient(join(dir, 'missing'))));
    expectRefusedClean(await call(), 'checker-failed');
  });
  it.each(['process.exit(1)', "console.log('garbage')"])('refuses when a real consume helper loses its reply: %s', async finish => {
    const helper = join(dir, 'helper'); const marker = join(dir, 'consumed');
    writeFileSync(helper, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'decremented'); ${finish}\n`); chmodSync(helper, 0o755);
    const actual = new TicketClient(helper); tickets.consume.mockImplementation(actual.consume.bind(actual));
    expect((await call()).isError).toBe(true); expect(readFileSync(marker, 'utf8')).toBe('decremented');
    expect(lastReceipt().reason).toBe('consume-indeterminate'); expect(run).not.toHaveBeenCalled();
  });
  it.each([['revoked', { allowed: false, reason: 'revoked' }, 'parent-refused:revoked'], ['scope', { ...decision, effectiveHash: 'changed' }, 'scope-changed']])('revalidates parent on each call: %s', async (_name, second, reason) => {
    expect((await call()).isError).not.toBe(true);
    grants.check.mockResolvedValueOnce(second);
    expect((await call()).isError).toBe(true);
    expect(lastReceipt().reason).toBe(reason);
    expect(grants.check).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledOnce(); expect(tickets.consume).toHaveBeenCalledOnce();
  });
  it('allows a ticket add_dir as cwd and resolves add_dirs', async () => {
    const other = join(dir, 'other'); mkdirSync(other); mkdirSync(join(other, 'sub')); symlinkSync(join(other, 'sub'), join(other, 'link'));
    ticket.add_dirs = [other];
    expect((await call({ cwd: other, add_dirs: [join(other, 'link')] })).isError).not.toBe(true);
    expect(run.mock.calls[0][0]).toMatchObject({ cwd: realpathSync(other), addDirs: [realpathSync(join(other, 'sub'))] });
    expect(lastReceipt()).toMatchObject({ cwd: project, child_cwd: realpathSync(other), child_add_dirs: [realpathSync(join(other, 'sub'))] });
  });
  it('rejects an add_dirs symlink outside', async () => {
    symlinkSync(dir, join(project, 'escape')); expectRefusedClean(await call({ add_dirs: ['escape'] }), 'outside-parent');
  });
  it.each(['0s', '0m', '1801s'])('rejects timeout %s before show', async timeout => {
    expectRefusedClean(await call({ timeout }), 'bad-request'); expect(tickets.show).not.toHaveBeenCalled();
    expect(lastReceipt()).toMatchObject({ child_cwd: null, child_add_dirs: null });
  });
  it.each(['30m', '1800s'])('accepts timeout %s', async timeout => {
    expect((await call({ timeout })).isError).not.toBe(true); expect(run.mock.calls[0][0].timeoutMs).toBe(1800000);
  });
  it('caps timeout at consumed ticket expiry', async () => {
    tickets.consume.mockResolvedValue({ ...ticket, expires_at: new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
    expect((await call({ timeout: '20m' })).isError).not.toBe(true);
    expect(run.mock.calls[0][0].timeoutMs).toBeGreaterThan(0); expect(run.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(5000);
  });
  it.each([undefined, 'not-a-date'])('refuses malformed consumed expiry %s', async expires_at => {
    tickets.consume.mockResolvedValue({ ...ticket, expires_at });
    expect((await call()).isError).toBe(true); expect(lastReceipt().reason).toBe('consume-indeterminate'); expect(run).not.toHaveBeenCalled();
  });
  it('refuses if consumed ticket already expired', async () => {
    tickets.consume.mockResolvedValue({ ...ticket, expires_at: '2000-01-01T00:00:00Z' });
    expect((await call()).isError).toBe(true); expect(lastReceipt().reason).toBe('expired'); expect(run).not.toHaveBeenCalled();
    expect(lastReceipt()).toMatchObject({ child_cwd: project, child_add_dirs: [] });
  });
  it('sends progress while running', async () => {
    run.mockImplementation(async () => { await new Promise(r => setTimeout(r, 50)); return result; });
    let progress = 0; await client.callTool({ name: 'claude', arguments: { prompt: 'hi' } }, undefined, { onprogress: () => { progress++; } }); expect(progress).toBeGreaterThan(0);
  });
});
