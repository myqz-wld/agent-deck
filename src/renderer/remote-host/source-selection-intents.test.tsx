// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteHostSnapshotDto, RemoteHostSourceMode } from '@shared/remote-host';
import { useRemoteHostSnapshot, type RemoteHostSnapshotState } from './use-remote-host-snapshot';

// Execute the actual App callback alongside the production hook, including its persistence calls.
function appSourceChoice(hosts: RemoteHostSnapshotState): (value: string) => void {
  const app = ts.createSourceFile('App.tsx', readFileSync('src/renderer/App.tsx', 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(app) === 'onSourceChange' &&
      node.initializer && ts.isJsxExpression(node.initializer)) callback = node.initializer.expression;
    ts.forEachChild(node, visit);
  };
  visit(app);
  if (!callback) throw new Error('App source callback not found');
  const code = ts.transpileModule(`return (${callback.getText(app)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('remoteHosts', 'logger', code)(hosts, { warn: vi.fn() });
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const firstSelection = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  let persisted: RemoteHostSnapshotDto = {
    revision: 1, sourceMode: 'local', selectedRemoteProfileId: null, profiles: [], states: [],
  };
  const update = (patch: Partial<RemoteHostSnapshotDto>) => {
    persisted = { ...persisted, ...patch, revision: persisted.revision + 1 };
    return persisted;
  };
  const setMode = vi.fn(async (sourceMode: RemoteHostSourceMode) => update({ sourceMode }));
  const selectProfile = vi.fn(async (selectedRemoteProfileId: string) => {
    if (selectedRemoteProfileId === 'a') await firstSelection;
    return update({ selectedRemoteProfileId });
  });
  window.api = {
    getRemoteHostSnapshot: async () => persisted,
    onRemoteHostChanged: () => () => {},
    selectRemoteHostProfile: selectProfile,
    setRemoteHostSourceMode: setMode,
  } as unknown as typeof window.api;
  return { release, reject, setMode, selectProfile, persisted: () => persisted };
}
afterEach(cleanup);

it('never persists an obsolete Remote activation after a newer Local App choice', async () => {
  const fixtureState = fixture();
  const hook = renderHook(() => useRemoteHostSnapshot());
  await act(flush);
  const choose = appSourceChoice(hook.result.current);
  act(() => { choose('remote:a'); choose('local'); });
  await act(flush);
  await act(async () => { fixtureState.release(); await flush(); });
  expect(fixtureState.setMode.mock.calls).toEqual([['local']]);
  expect(fixtureState.persisted().sourceMode).toBe('local');
  expect(hook.result.current.snapshot?.sourceMode).toBe('local');
  expect(hook.result.current.mutations.sourceSelection).toBe(false);
});

it('serializes complete Remote choices and activates only the newest profile', async () => {
  const fixtureState = fixture();
  const hook = renderHook(() => useRemoteHostSnapshot());
  await act(flush);
  const choose = appSourceChoice(hook.result.current);
  act(() => { choose('remote:a'); choose('local'); choose('remote:b'); });
  await act(async () => { fixtureState.release(); await flush(); });
  expect(fixtureState.setMode.mock.calls).toEqual([['local'], ['remote']]);
  expect(fixtureState.persisted()).toMatchObject({ sourceMode: 'remote', selectedRemoteProfileId: 'b' });
  expect(hook.result.current.snapshot).toEqual(fixtureState.persisted());
});

it('treats a profile-manager selection as a newer intent at the same boundary', async () => {
  const fixtureState = fixture();
  const hook = renderHook(() => useRemoteHostSnapshot());
  await act(flush);
  act(() => appSourceChoice(hook.result.current)('remote:a'));
  let managerChoice!: Promise<void>;
  act(() => { managerChoice = hook.result.current.selectProfile('b'); });
  await act(async () => { fixtureState.release(); await managerChoice; await flush(); });
  expect(fixtureState.setMode).not.toHaveBeenCalled();
  expect(fixtureState.persisted()).toMatchObject({ sourceMode: 'local', selectedRemoteProfileId: 'b' });
});

it('continues the newest intent when an older profile selection fails', async () => {
  const fixtureState = fixture();
  const hook = renderHook(() => useRemoteHostSnapshot());
  await act(flush);
  const choose = appSourceChoice(hook.result.current);
  act(() => { choose('remote:a'); choose('remote:b'); });
  await act(async () => { fixtureState.reject(new Error('profile unavailable')); await flush(); });
  expect(fixtureState.persisted()).toMatchObject({ sourceMode: 'remote', selectedRemoteProfileId: 'b' });
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.error).toBeNull();
});
