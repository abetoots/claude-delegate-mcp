import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Ticket {
  allowed: true; reason: 'allowed'; grant_id: string | null; parent_harness: 'codex' | 'gemini';
  project: string | null; dispatch_id: string; effective_hash: string; revision: number | null;
  cwd: string; add_dirs: string[]; remaining: number; expires_at: string;
}
export type TicketDecision = Ticket | { allowed: false; reason: 'unknown' | 'expired' | 'budget' | 'store-unreadable' | 'consume-indeterminate' };
export function defaultTicketHelperPath(): string { return process.env.AI_DELEGATION_TICKET_HELPER ?? join(homedir(), 'ai-cli-sync', 'bin', 'delegation-ticket'); }

export function ticketExpiryMs(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace('Z', '.000Z') ? time : NaN;
}

export class TicketClient {
  constructor(private readonly helperPath: string) {}
  show(id: string): Promise<TicketDecision> { return this.call('show', id); }
  consume(id: string): Promise<TicketDecision> { return this.call('consume', id); }
  private call(action: 'show' | 'consume', id: string): Promise<TicketDecision> {
    const failure = (): TicketDecision => ({ allowed: false, reason: action === 'consume' ? 'consume-indeterminate' : 'store-unreadable' });
    return new Promise(resolve => {
      let out = '', done = false;
      const finish = (result: TicketDecision) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      const child = spawn(this.helperPath, [action], { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); finish(failure()); }, 10_000);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (s: string) => { out += s; }); child.stderr.resume();
      child.stdin.on('error', () => {}); child.on('error', () => finish(failure()));
      child.on('close', code => {
        if (code === 3) return finish({ allowed: false, reason: 'store-unreadable' });
        try {
          const w = JSON.parse(out);
          if (code === 2 && w.allowed === false && ['unknown', 'expired', 'budget'].includes(w.reason)) return finish({ allowed: false, reason: w.reason });
          if (code === 0 && w.allowed === true && w.reason === 'allowed' && (w.grant_id === null || typeof w.grant_id === 'string') && ['codex', 'gemini'].includes(w.parent_harness) && (w.project === null || typeof w.project === 'string') && typeof w.dispatch_id === 'string' && typeof w.effective_hash === 'string' && (w.revision === null || (Number.isInteger(w.revision) && w.revision >= 0)) && typeof w.cwd === 'string' && Array.isArray(w.add_dirs) && w.add_dirs.every((p: unknown) => typeof p === 'string') && Number.isInteger(w.remaining) && w.remaining >= 0 && Number.isFinite(ticketExpiryMs(w.expires_at))) return finish(w as Ticket);
        } catch { /* malformed output fails closed */ }
        finish(failure());
      });
      child.stdin.end(JSON.stringify({ ticket_id: id }));
    });
  }
}
