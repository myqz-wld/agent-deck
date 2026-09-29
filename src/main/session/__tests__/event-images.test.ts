import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentEvent } from '@shared/types';
import { eventImages } from '@shared/event-images';

const state = vi.hoisted(() => ({ root: '', db: null as Database.Database | null }));
vi.mock('@main/runtime-host/application-paths', () => ({ getApplicationHostPaths: () => ({ userDataPath: state.root }) }));
vi.mock('@main/store/db', () => ({ getDb: () => state.db }));
import { prepareEventImages } from '../event-images';
import { loadEventImage } from '@main/store/event-image-repo';
import { decodeEventImage } from '@main/store/event-image-files';
import { legacyEventImage } from '@main/store/legacy-event-image';
import { safeStringifyPayload } from '@main/store/payload-truncate';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=';
function persist(payload: unknown): AgentEvent {
  const event = prepareEventImages({ sessionId: 'session-one', agentId: 'codex-cli', kind: 'tool-use-end', ts: 1, payload }, state.root);
  state.db!.prepare('INSERT INTO events(session_id,payload_json) VALUES(?,?)').run(event.sessionId, safeStringifyPayload(event.payload));
  return event;
}
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'event-image-test-'));
  state.db = new Database(':memory:');
  state.db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, session_id TEXT, payload_json TEXT)');
});
afterEach(() => { state.db?.close(); rmSync(state.root, { recursive: true, force: true }); });

describe('provider event image ownership', () => {
  it.each([
    { imageInputs: [{ data: PNG }] },
    { toolResult: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
    { toolResult: { content: [{ type: 'image', mimeType: 'image/png', data: PNG }] } },
    { toolResult: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] },
    { toolResult: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` }] },
    { toolResult: { type: 'image', file: { base64: PNG, mimeType: 'image/png' } } },
  ])('persists provider images outside event JSON and authorizes only their session', async (payload) => {
    const event = persist(payload);
    const [image] = eventImages(event.payload);
    expect(image).toMatchObject({ mime: 'image/png', bytes: Buffer.from(PNG, 'base64').length });
    expect(JSON.stringify(event.payload)).not.toContain(PNG);
    expect(await loadEventImage('session-one', image.id)).toMatchObject({ ok: true, dataUrl: `data:image/png;base64,${PNG}` });
    expect(await loadEventImage('session-other', image.id)).toEqual({ ok: false, reason: 'denied' });
  });
  it('supports a provider saved path and refuses a Remote symlink escape', async () => {
    const outside = join(state.root, 'outside.png');
    const workspace = join(state.root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(outside, Buffer.from(PNG, 'base64'));
    const path = join(workspace, 'image.png');
    symlinkSync(outside, path);
    const [image] = eventImages(persist({ imageInputs: [{ kind: 'path', path }] }).payload);
    expect(await loadEventImage('session-one', image.id)).toMatchObject({ ok: true });
    expect(await loadEventImage('session-one', image.id, workspace)).toEqual({ ok: false, reason: 'denied' });
  });
  it('keeps the tool result and an actionable warning when image data is invalid', () => {
    const event = persist({ toolResult: [{ type: 'text', text: 'done' }, { type: 'image', data: 'invalid' }] });
    expect(eventImages(event.payload)).toEqual([]);
    expect(event.payload).toMatchObject({ imageWarnings: [expect.any(String)], toolResult: [{ type: 'text', text: 'done' }, { type: 'image', unavailable: true }] });
  });
  it('keeps image read authority when unrelated output exceeds the event JSON cap', async () => {
    const [image] = eventImages(persist({ imageInputs: [{ data: PNG }], toolResult: { huge: 'x'.repeat(300 * 1024) } }).payload);
    const row = state.db!.prepare('SELECT payload_json FROM events').get() as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({ __truncated: true, images: [{ id: image.id }] });
    expect(row.payload_json.length).toBeLessThan(256 * 1024);
    expect(await loadEventImage('session-one', image.id)).toMatchObject({ ok: true });
  });
  it('persists images from tool progress and represents explicit content replacement', () => {
    const event: AgentEvent = { sessionId: 'session-one', agentId: 'grok-build', kind: 'tool-use-start', ts: 1,
      payload: { imageInputs: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } };
    const prepared = prepareEventImages(event, state.root);
    expect(eventImages(prepared.payload)).toHaveLength(1);
    expect(JSON.stringify(prepared.payload)).not.toContain(PNG);
    expect(prepareEventImages({ ...event, payload: { imageInputs: [] } }, state.root).payload).toEqual({ images: [] });
  });
  it('rejects mismatched MIME, active formats, oversized input, and arbitrary URLs', () => {
    expect(() => decodeEventImage(PNG, 'image/jpeg')).toThrow();
    expect(() => decodeEventImage('data:image/svg+xml;base64,PHN2Zy8+')).toThrow();
    expect(() => decodeEventImage('A'.repeat(24 * 1024 * 1024))).toThrow();
    expect(() => decodeEventImage('https://example.test/image.png')).toThrow();
  });
  it('validates multi-megabyte data without exhausting the regular-expression stack', () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    Buffer.from(PNG, 'base64').copy(bytes);
    expect(decodeEventImage(bytes.toString('base64')).buffer.length).toBe(bytes.length);
    expect(() => decodeEventImage(`${PNG}=`)).toThrow();
  });
  it('ignores malformed historical image arrays and revokes access when the event is deleted', async () => {
    state.db!.prepare('INSERT INTO events(session_id,payload_json) VALUES(?,?)').run('session-one', JSON.stringify({ images: ['invalid'] }));
    const [image] = eventImages(persist({ imageInputs: [{ data: PNG }] }).payload);
    state.db!.prepare('DELETE FROM events').run();
    expect(await loadEventImage('session-one', image.id)).toEqual({ ok: false, reason: 'denied' });
  });
  it('reads a saved image from legacy Codex history without changing the original record', async () => {
    const path = join(state.root, 'old-generated.png');
    writeFileSync(path, Buffer.from(PNG, 'base64'));
    const payload = { toolName: 'ImageGeneration', toolResult: { savedPath: path, hasInlineResult: true } };
    const row = state.db!.prepare('INSERT INTO events(session_id,payload_json) VALUES(?,?)').run('session-one', JSON.stringify(payload));
    const image = legacyEventImage(payload, Number(row.lastInsertRowid))!;
    expect(await loadEventImage('session-one', image.id)).toMatchObject({ ok: true });
    expect(await loadEventImage('session-other', image.id)).toEqual({ ok: false, reason: 'denied' });
  });
});
