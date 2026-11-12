import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, expect, it } from 'vitest';
import { TicketClient } from './ticket-client.js';

let dir: string, helper: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ticket-client-')); helper = join(dir, 'helper'); });
function fixture(body: string) {
  writeFileSync(helper, `#!/usr/bin/env node\n${body}\n`); chmodSync(helper, 0o755);
  return new TicketClient(helper);
}
it('sends the ticket id and action to a helper without a shell', async () => {
  const log = join(dir, 'request');
  const allowed = { allowed: true, reason: 'allowed', grant_id: null, parent_harness: 'gemini', project: null, dispatch_id: 'd', effective_hash: 'h', revision: null, cwd: '/p', add_dirs: [], remaining: 3, expires_at: '2099-01-01T00:00:00Z' };
  const client = fixture(`let data=''; process.stdin.on('data', x => data += x); process.stdin.on('end', () => { require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify([process.argv[2], JSON.parse(data)])); console.log(${JSON.stringify(JSON.stringify(allowed))}); });`);
  expect(await client.consume('a'.repeat(32))).toEqual(allowed);
  expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(['consume', { ticket_id: 'a'.repeat(32) }]);
});
it('maps exit 3 to an unreadable store', async () => {
  expect(await fixture('process.exit(3)').show('id')).toEqual({ allowed: false, reason: 'store-unreadable' });
});
it.each(["process.exit(1)", "console.log('not json')", "console.log(JSON.stringify({allowed:true}))"] )('treats uncertain consume as indeterminate: %s', async body => {
  expect(await fixture(body).consume('id')).toEqual({ allowed: false, reason: 'consume-indeterminate' });
});
it('accepts only the specified denial reasons on exit 2', async () => {
  expect(await fixture("console.log(JSON.stringify({allowed:false,reason:'budget'})); process.exitCode=2").consume('id')).toEqual({ allowed: false, reason: 'budget' });
  expect(await fixture("console.log(JSON.stringify({allowed:false,reason:'unexpected'})); process.exitCode=2").show('id')).toEqual({ allowed: false, reason: 'store-unreadable' });
});

it.each([undefined, 'invalid', '2026-02-30T00:00:00Z', '2026-01-01T00:00:00.000Z'])('rejects malformed expiry %s on consume', async expires_at => {
  const allowed = { allowed: true, reason: 'allowed', grant_id: null, parent_harness: 'gemini', project: null, dispatch_id: 'd', effective_hash: 'h', revision: null, cwd: '/p', add_dirs: [], remaining: 3, expires_at };
  expect(await fixture(`console.log(${JSON.stringify(JSON.stringify(allowed))})`).consume('id')).toEqual({ allowed: false, reason: 'consume-indeterminate' });
});
