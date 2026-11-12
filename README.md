# claude-delegate-mcp

A stdio MCP server with one tool, `claude`. It lets a Codex or Antigravity session ask Claude for a one-shot, read-only second opinion. The calling session can never get more through it than it already has.

Claude itself never registers this server. The Codex wrapper injects it into each thread it starts. The hub delivers it to agy's `mcp_config.json`.

## What a call may do

- The child is `claude -p --restricted` with only `Read`, `Glob`, `Grep`, `WebSearch` and `WebFetch`. It has no write or shell tools, no MCP servers, and no saved session (`src/claude.ts`).
- Its `cwd` and `add_dirs` must resolve, after realpath, inside the parent session's directories. Paths outside are refused before anything runs.
- The child cannot call the delegate again (`CLAUDE_DELEGATE_DEPTH`).
- Its timeout defaults to 20 min, may not exceed 30 min, and is cut to the ticket's remaining life.

## Admission

Every call needs a delegation ticket in `AI_DELEGATION_TICKET`. The parent's wrapper issues one per session through the hub's `bin/delegation-ticket`. A ticket has a budget of 4 calls and expires with the parent's grant, or after 8 h, whichever comes first. The checks run in this order (`src/server.ts`):

1. depth;
2. ticket present;
3. `show`;
4. paths inside the parent;
5. parent revalidated with the hub's `bin/grant-check` (phase `resume`), including its effective-scope hash;
6. `consume` (spends one unit);
7. spawn.

A refusal before step 6 spends nothing.

## Receipts

Every call appends one line to `~/.local/state/claude-delegate/receipts.jsonl` (or `$CLAUDE_DELEGATE_STATE_DIR`), mode 0600. The line records the status, the reason, the ticket's hash, the parent harness, project and cwd, the child's resolved `child_cwd` and `child_add_dirs`, the model and the duration. Prompts, responses, checker text and stderr are never written.

## Build and test

```sh
npm ci && npm run build   # dist/index.js is what the wrappers run
npm test                  # vitest; helper and checker default to missing paths
```

## Environment

| variable | default |
|---|---|
| `AI_DELEGATION_TICKET` | none (required) |
| `AI_DELEGATION_TICKET_HELPER` | `~/ai-cli-sync/bin/delegation-ticket` |
| `AI_GRANT_CHECK` | `~/ai-cli-sync/bin/grant-check` |
| `CLAUDE_DELEGATE_STATE_DIR` | `~/.local/state/claude-delegate` |

## Withdrawing it

For agy, run `bin/apply --withdraw claude` in the hub first; it needs the `delegation.claude` declaration present. Then remove the declaration. For Codex, revert the wrapper to its pre-E5 commit and restart it. Running sessions keep the tool until they end, and their tickets expire within 8 h.
