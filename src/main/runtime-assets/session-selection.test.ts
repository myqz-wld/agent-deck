import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishAssetSnapshot } from './snapshot-store';
import { SessionAssetSelections } from './session-selection';

let root: string;
let source: string;
let destination: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'asset-selection-'));
  source = join(root, 'source'); destination = join(root, 'assets');
  fs.mkdirSync(source); fs.writeFileSync(join(source, 'SKILL.md'), 'one');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const publish = () => publishAssetSnapshot({ source, destination, identity: { provider: 'fixture' } }, fs).path;
const store = () => new SessionAssetSelections(`${destination}.sessions`);

describe('history-owned snapshot retention', () => {
  it('collects prepared candidates never adopted by a session at startup', () => {
    const path = publish(); store().retire([path]); store().collectReleased();
    expect(fs.existsSync(path)).toBe(false);
  });
  it('preserves shared and previous versions until every history owner is removed', () => {
    const selections = store(); const first = publish();
    selections.select('a', () => [first]); selections.select('b', () => [first]);
    fs.writeFileSync(join(source, 'SKILL.md'), 'two'); const second = publish();
    selections.replace('a', [second]);
    selections.release('a');
    expect(fs.existsSync(second)).toBe(true); // Disposal is not proof the provider has drained.
    store().collectReleased();
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(first)).toBe(true);
    selections.release('b'); store().collectReleased();
    expect(fs.existsSync(first)).toBe(false);
  });

  it('preserves selection across rename and process restart, including empty selections', () => {
    const first = publish(); store().select('temporary', () => [first]);
    store().rename('temporary', 'canonical');
    expect(store().select('canonical', () => [])).toEqual([first]);
    store().select('disabled', () => []);
    expect(store().select('disabled', () => [first])).toEqual([]);
    store().release('canonical'); store().collectReleased();
    expect(fs.existsSync(first)).toBe(false);
  });

  it('retains unknown legacy paths and fails closed on corrupt owner records', () => {
    const first = publish(); store().select('a', () => [first, source]);
    store().release('a');
    fs.writeFileSync(join(`${destination}.sessions`, 'unknown.json'), '{');
    expect(() => store().collectReleased()).toThrow();
    expect(fs.existsSync(first)).toBe(true);
    fs.rmSync(join(`${destination}.sessions`, 'unknown.json'));
    store().collectReleased();
    expect(fs.existsSync(source)).toBe(true);
  });

  it('rejects links and removes staging on copy or source-change failure', () => {
    fs.symlinkSync(source, join(source, 'link'));
    expect(publish).toThrow(/links/);
    fs.rmSync(join(source, 'link'));
    expect(() => publishAssetSnapshot({ source, destination, identity: {} }, {
      ...fs, cpSync: ((from, to, options) => {
        fs.cpSync(from, to, options); fs.writeFileSync(join(String(to), 'SKILL.md'), 'raced');
      }) as typeof fs.cpSync,
    })).toThrow(/changed/);
    expect(fs.readdirSync(`${destination}.versions`)).toEqual([]);
  });
});
