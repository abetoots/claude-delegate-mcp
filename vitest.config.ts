import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const dir = mkdtempSync(join(tmpdir(), 'delegate-test-'));
export default defineConfig({
  test: { env: { AI_DELEGATION_TICKET_HELPER: join(dir, 'missing-ticket-helper'), AI_GRANT_CHECK: join(dir, 'missing-grant-check'), CLAUDE_DELEGATE_STATE_DIR: dir } },
});
