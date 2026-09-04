import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const RULES_TIMEOUT_MS = 120_000;

describe('check:rules', () => {
  it(
    'passes on the current repo',
    () => {
      const result = spawnSync(process.execPath, ['scripts/check-rules.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: RULES_TIMEOUT_MS,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(0);
    },
    RULES_TIMEOUT_MS,
  );
});
