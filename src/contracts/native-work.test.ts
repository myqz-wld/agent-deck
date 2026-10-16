import { describe, expect, it } from 'vitest';
import { parseNativeWorkDetailParams, parseNativeWorkDetailResult, parseNativeWorkStopParams, parseNativeWorkListParams, readNativeWorkDetail } from './native-work';
const ref = { sessionId: 's', provider: 'codex-cli', nativeId: 'child', runId: 'run', runtimeId: 'runtime' };
describe('native work bounded contracts', () => {
  it('round trips bounded conversation metadata while accepting older records', () => {
    const old = { native: ref, recordId: 'record', recordRevision: 1, kind: 'output', text: 'result',
      part: 0, parts: 1, ts: 1, sourceTruncated: false };
    expect(readNativeWorkDetail(old)).toEqual(old);
    const current = { ...old, toolUseId: 'call', toolName: 'Bash', toolStatus: 'failed', exitCode: -1, role: 'assistant' };
    expect(readNativeWorkDetail(current)).toEqual(current);
    for (const patch of [{ toolUseId: 'x'.repeat(513) }, { role: 'developer' }, { role: ['user'] }, { exitCode: NaN }, { toolStatus: 'bad\nstatus' }]) {
      expect(readNativeWorkDetail({ ...current, ...patch })).toBeNull();
    }
  });
  it('rejects unbounded pages, malformed references and extra control fields', () => {
    expect(parseNativeWorkDetailParams({ ref, order: 'desc', cursor: 8 })).toEqual({ ref, order: 'desc', cursor: 8 });
    expect(() => parseNativeWorkDetailParams({ ref, order: 'newest' })).toThrow();
    expect(() => parseNativeWorkDetailParams({ ref, limit: 33 })).toThrow();
    expect(() => parseNativeWorkListParams({ sessionId: 's', limit: 101 })).toThrow();
    expect(() => parseNativeWorkStopParams({ ref: { ...ref, pid: 1 } })).toThrow();
    expect(() => parseNativeWorkStopParams({ ref, method: 'process/kill' })).toThrow();
  });
  it('rejects cross-owner results and malformed nested payloads before rendering', () => {
    const record = { native: { ...ref, sessionId: 'other' }, id: 1, recordId: 'm', recordRevision: 1,
      kind: 'message', text: 'secret', part: 0, parts: 1, ts: 1, sourceTruncated: false };
    const target = parseNativeWorkStopParams({ ref }).ref;
    expect(() => parseNativeWorkDetailResult({ records: [record], nextCursor: null, revision: 1 }, target)).toThrow();
    expect(() => parseNativeWorkDetailResult({ records: [{ ...record, native: ref, text: { nested: 'invalid' } }], nextCursor: null, revision: 1 }, target)).toThrow();
  });
});
