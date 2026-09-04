import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

const claude = readFileSync(root('CLAUDE.md'));
const agents = readFileSync(root('AGENTS.md'));

describe('AGENTS.md mirrors CLAUDE.md', () => {
  it('is byte-identical', () => {
    expect(
      agents.equals(claude),
      'AGENTS.md a rămas în urmă. Rulează `cp CLAUDE.md AGENTS.md` din rădăcina repo-ului.',
    ).toBe(true);
  });

  it('tells the reader which file to edit', () => {
    const header = claude.toString('utf8').slice(0, 700);
    expect(header).toContain('CLAUDE.md');
    expect(header).toContain('AGENTS.md');
    expect(header).toMatch(/never edit `AGENTS\.md` directly/);
  });
});
