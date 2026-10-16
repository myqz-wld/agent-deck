import { describe, expect, it } from 'vitest';
import { parseNativeWorkDetailParams, parseNativeWorkDetailResult, parseNativeWorkStopParams, parseNativeWorkListParams } from './native-work';
const ref = { sessionId: 's', provider: 'codex-cli', nativeId: 'child', runId: 'run', runtimeId: 'runtime' };
describe('native work bounded contracts', () => {
  it('rejects unbounded pages, malformed references and extra control fields', () => {
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
