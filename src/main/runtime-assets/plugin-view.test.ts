import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishAssetSnapshot } from './snapshot-store';
import { sessionAssetSelections } from './session-selection';
import { sessionPluginView, stagePluginView } from './plugin-view';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'plugin-view-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
  const source = join(root, 'source'); const destination = join(root, 'plugins');
  fs.mkdirSync(source); fs.writeFileSync(join(source, 'SKILL.md'), 'old');
  const publish = () => publishAssetSnapshot({ source, destination, identity: {} }, fs).path;
  const previous = publish(); const selections = sessionAssetSelections(destination);
  selections.select('one', () => [previous]); selections.select('two', () => [previous]);
  const [one] = sessionPluginView(destination, 'one', [previous]);
  const [two] = sessionPluginView(destination, 'two', [previous]);
  fs.writeFileSync(join(source, 'SKILL.md'), 'new'); const next = publish();
  return { destination, selections, previous, next, one: one!, two: two! };
}
describe('session-owned plugin views', () => {
  it('restores a held refresh without changing another session or immutable snapshots', () => {
    const f = fixture(); const staged = stagePluginView(f.destination, 'one', f.next)!;
    expect(fs.readFileSync(join(f.one, 'SKILL.md'), 'utf8')).toBe('new');
    expect(fs.readFileSync(join(f.two, 'SKILL.md'), 'utf8')).toBe('old');
    expect(fs.readFileSync(join(f.previous, 'SKILL.md'), 'utf8')).toBe('old');
    staged.restore(); staged.restore();
    expect(fs.readFileSync(join(f.one, 'SKILL.md'), 'utf8')).toBe('old');
    expect(f.selections.get('one')).toEqual([f.previous]);
  });
  it('recovers an interrupted refresh from the durable selection before reloading a session', () => {
    const f = fixture(); stagePluginView(f.destination, 'one', f.next);
    expect(sessionPluginView(f.destination, 'one', f.selections.get('one')!)).toEqual([f.one]);
    expect(fs.readFileSync(join(f.one, 'SKILL.md'), 'utf8')).toBe('old');
    const staged = stagePluginView(f.destination, 'one', f.next)!; staged.commit(); staged.commit();
    expect(f.selections.get('one')).toEqual([f.next]);
    fs.rmSync(f.one, { recursive: true });
    sessionPluginView(f.destination, 'one', f.selections.get('one')!);
    expect(fs.readFileSync(join(f.one, 'SKILL.md'), 'utf8')).toBe('new');
  });
  it('rejects corrupt candidates before touching the selected view', () => {
    const f = fixture(); fs.writeFileSync(join(f.next, 'SKILL.md'), 'corrupt');
    expect(() => stagePluginView(f.destination, 'one', f.next)).toThrow(/损坏/);
    expect(fs.readFileSync(join(f.one, 'SKILL.md'), 'utf8')).toBe('old');
    expect(fs.readdirSync(`${f.destination}.views`).filter(name => name.includes('.staging-'))).toEqual([]);
  });
  it('retains the view through close and collects it only after permanent history deletion at startup', () => {
    const f = fixture(); f.selections.release('one');
    expect(fs.existsSync(f.one)).toBe(true);
    f.selections.collectReleased();
    expect(fs.existsSync(f.one)).toBe(false); expect(fs.existsSync(f.two)).toBe(true);
    expect(fs.existsSync(f.previous)).toBe(true);
  });
});
