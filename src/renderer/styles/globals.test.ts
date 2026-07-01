/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'globals.css'), 'utf8');

describe('renderer global theme', () => {
  it('defines the error color token used by red diff utilities', () => {
    expect(css).toMatch(/--color-status-error:\s*rgb\(255,\s*80,\s*80\);/);
  });
});
