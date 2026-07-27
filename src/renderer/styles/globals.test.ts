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

  it('keeps transparent windows out of the full-frame backdrop-filter compositor path', () => {
    const transparentRule = css.match(
      /\.frosted-frame\[data-transparent='true'\]\s*\{(?<body>[^}]*)\}/,
    )?.groups?.body;

    expect(transparentRule).toBeDefined();
    expect(transparentRule).toMatch(/(?:^|\s)backdrop-filter:\s*none;/);
    expect(transparentRule).toMatch(/-webkit-backdrop-filter:\s*none;/);
    expect(transparentRule).not.toMatch(/backdrop-filter:[^;]*blur\(/);
    expect(transparentRule).not.toMatch(/transition:[^;]*backdrop-filter/);
  });
});
