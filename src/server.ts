import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runClaude as defaultRunClaude } from './claude.js';
import { GrantClient, defaultCheckerPath } from './grant-client.js';
import { TicketClient, defaultTicketHelperPath, type Ticket } from './ticket-client.js';

export const KEEPALIVE_MS = 10_000;
const denialCodes = new Set(['bad-request', 'expired', 'missing', 'multiple-projects', 'outside-roots', 'project-changed', 'project-mismatch', 'revision-changed', 'revoked', 'checker-exit-mismatch']);
interface ServerDeps {
  keepaliveMs?: number;
  runClaude?: typeof defaultRunClaude;
  grants?: Pick<GrantClient, 'check'>;
  tickets?: Pick<TicketClient, 'show' | 'consume'>;
  receiptPath?: string;
  settingsPath?: string;
}
export function createServer({ keepaliveMs = KEEPALIVE_MS, runClaude = defaultRunClaude, grants, tickets, receiptPath, settingsPath }: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'claude-delegate', version: '0.1.0' });
  server.registerTool('claude', {
    description: 'Run a read-only Claude delegate under the parent session grant.',
    inputSchema: { prompt: z.any().optional(), model: z.any().optional(), effort: z.any().optional(), timeout: z.any().optional(), cwd: z.any().optional(), add_dirs: z.any().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args, extra) => {
    let ticket: Ticket | undefined;
    let id = '';
    const record = async (status: 'refused' | 'ok' | 'error' | 'timeout', reason: string | null, details: Record<string, unknown> = {}) => {
      const path = receiptPath ?? join(process.env.CLAUDE_DELEGATE_STATE_DIR ?? join(homedir(), '.local', 'state', 'claude-delegate'), 'receipts.jsonl');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, JSON.stringify({ ts: new Date().toISOString(), status, reason, ticket_hash: ticket ? createHash('sha256').update(id).digest('hex') : null, parent_harness: ticket?.parent_harness ?? null, dispatch_id: ticket?.dispatch_id ?? null, project: ticket?.project ?? null, cwd: ticket?.cwd ?? null, ...details }) + '\n', { mode: 0o600 });
    };
    const refuse = async (reason: string) => {
      try { await record('refused', reason); } catch { return { content: [{ type: 'text' as const, text: 'Refused: receipt could not be written.' }], isError: true }; }
      return { content: [{ type: 'text' as const, text: `Refused: ${reason}.` }], isError: true };
    };
    const validString = (x: unknown) => typeof x === 'string' && x.length > 0;
    const timeout = args.timeout ?? '20m';
    const match = typeof timeout === 'string' ? /^(\d+)(s|m)$/.exec(timeout) : null;
    const timeoutMs = match ? Number(match[1]) * (match[2] === 'm' ? 60_000 : 1_000) : NaN;
    if (!validString(args.prompt) || (args.model !== undefined && !validString(args.model)) || (args.effort !== undefined && !validString(args.effort)) || (args.cwd !== undefined && !validString(args.cwd)) || (args.add_dirs !== undefined && (!Array.isArray(args.add_dirs) || !args.add_dirs.every(validString))) || !Number.isFinite(timeoutMs) || timeoutMs > 1_800_000) return refuse('bad-request');
    if (process.env.CLAUDE_DELEGATE_DEPTH !== undefined) return refuse('depth');
    id = process.env.AI_DELEGATION_TICKET ?? '';
    if (!id) return refuse('no-ticket');
    const client = tickets ?? new TicketClient(defaultTicketHelperPath());
    let shown;
    try { shown = await client.show(id); } catch { return refuse('store-unreadable'); }
    if (!shown.allowed) return refuse(shown.reason);
    ticket = shown;
    let cwd: string, addDirs: string[];
    try {
      const roots = await Promise.all([ticket.cwd, ...ticket.add_dirs].map(p => realpath(p)));
      cwd = await realpath(resolve(ticket.cwd, args.cwd ?? ticket.cwd));
      addDirs = await Promise.all((args.add_dirs ?? []).map((p: string) => realpath(resolve(ticket!.cwd, p))));
      const inside = (p: string) => roots.some(root => { const rel = relative(root, p); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); });
      if (![cwd, ...addDirs].every(inside)) return refuse('outside-parent');
    } catch { return refuse('outside-parent'); }
    try {
      const check = await (grants ?? new GrantClient(defaultCheckerPath())).check({ phase: 'resume', harness: ticket.parent_harness, cwd: ticket.cwd, addDirs: ticket.add_dirs, grantId: ticket.grant_id, revision: ticket.revision, boundProject: ticket.project });
      if (!check.allowed) return refuse(denialCodes.has(check.reason) ? `parent-refused:${check.reason}` : 'checker-failed');
      if (check.effectiveHash !== ticket.effective_hash) return refuse('scope-changed');
    } catch { return refuse('checker-failed'); }
    let model = args.model;
    if (!model) {
      try { const settings = JSON.parse(await readFile(settingsPath ?? join(homedir(), '.claude', 'settings.json'), 'utf8')); model = validString(settings.model) ? settings.model : 'opus'; } catch { model = 'opus'; }
    }
    let consumed;
    try { consumed = await client.consume(id); } catch { return refuse('consume-indeterminate'); }
    if (!consumed.allowed) return refuse(consumed.reason);
    const token = extra._meta?.progressToken;
    let progress = 0;
    const timer = token === undefined ? undefined : setInterval(() => { void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: 'working' } }).catch(() => {}); }, keepaliveMs);
    try {
      const result = await runClaude({ prompt: args.prompt, model, ...(args.effort === undefined ? {} : { effort: args.effort }), timeoutMs, cwd, addDirs }, { signal: extra.signal });
      const status = result.status;
      const reason = status === 'ok' ? null : status === 'timeout' ? 'timeout' : 'child-error';
      await record(status, reason, { model_resolved: result.model_resolved, duration_seconds: result.duration_seconds });
      return { content: [{ type: 'text' as const, text: status === 'ok' ? result.response || '(empty response)' : `Claude failed: ${reason}.` }], structuredContent: { status, response: status === 'ok' ? result.response : '', model_resolved: result.model_resolved, duration_seconds: result.duration_seconds, ticket_remaining: consumed.remaining }, isError: status !== 'ok' };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const reason = code === 'cancelled' || code === 'no-result' ? code : 'child-error';
      try { await record('error', reason); } catch { return { content: [{ type: 'text' as const, text: 'Claude failed: receipt could not be written.' }], isError: true }; }
      return { content: [{ type: 'text' as const, text: `Claude failed: ${reason}.` }], isError: true };
    } finally { if (timer !== undefined) clearInterval(timer); }
  });
  return server;
}
