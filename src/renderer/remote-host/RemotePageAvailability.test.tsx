// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RemoteHostConnectionStatus } from '@shared/remote-host';
import type { RemoteSessionSourceView } from './source-types';
import {
  RemotePageUnavailable,
  remotePageAvailability,
  unknownSourceAvailability,
} from './RemotePageAvailability';

function source(
  status: RemoteHostConnectionStatus | null,
  usable: boolean,
  capabilities: string[] = ['issues'],
): RemoteSessionSourceView {
  return {
    capabilities: new Set(capabilities),
    profile: { id: 'remote-a', label: 'Remote A', scope: 'remote' },
    state: status ? {
      profileId: 'remote-a',
      status,
      recovery: null,
      authoritativeCoreId: 'core-a',
      workerGeneration: 1,
      capabilities,
      eventRevision: 1,
      error: status === 'incompatible'
        ? { code: 'protocol_violation', message: '收到冲突的终态响应。' }
        : null,
    } : null,
    usable,
  } as unknown as RemoteSessionSourceView;
}

describe('Remote page availability', () => {
  it('admits only a connected, usable source with the requested capability', () => {
    expect(remotePageAvailability(source('connected', true), 'issues').kind).toBe('available');
    expect(remotePageAvailability(source('connected', false), 'issues').kind).toBe('offline');
    expect(remotePageAvailability(source('connected', true, []), 'issues').kind)
      .toBe('unsupported');
  });

  it.each([
    ['connecting', '正在连接远端'],
    ['reconnecting', '正在重新连接远端'],
  ] as const)('keeps stale capabilities inactive while %s', (status, title) => {
    const availability = remotePageAvailability(source(status, true), 'issues');
    expect(availability).toMatchObject({ kind: 'connecting', title });
  });

  it.each([
    ['offline', false, '远端当前不可用'],
    ['incompatible', false, '远端版本不兼容'],
  ] as const)('classifies %s as a stable unavailable page', (status, usable, title) => {
    expect(remotePageAvailability(source(status, usable), 'issues')).toMatchObject({
      kind: 'offline',
      title,
    });
  });

  it('renders bounded source-specific copy without implying a Local fallback', () => {
    const availability = remotePageAvailability(source('incompatible', false), 'issues');
    render(<RemotePageUnavailable availability={availability} />);
    expect(screen.getByText('远端版本不兼容')).toBeTruthy();
    expect(screen.getByText('问题当前不可用，请检查连接后重试。')).toBeTruthy();
    expect(screen.getByText('收到冲突的终态响应。')).toBeTruthy();
  });

  it.each([
    ['live', ['session-console.read']],
    ['history', ['session-console.read', 'sessions.history']],
    ['pending', ['pending.index.read']],
    ['issues', ['issues']],
    ['data', ['usage']],
  ] as const)('requires the complete %s surface capability set', (surface, capabilities) => {
    expect(remotePageAvailability(source('connected', true, [...capabilities]), surface).kind)
      .toBe('available');
    expect(remotePageAvailability(source('connected', true, capabilities.slice(1)), surface).kind)
      .toBe('unsupported');
  });

  it('renders a fail-closed state while source authority is unknown', () => {
    render(<RemotePageUnavailable availability={unknownSourceAvailability(null)} />);
    expect(screen.getByText('正在确认数据源')).toBeTruthy();
    expect(screen.getByText('正在确认数据来源，完成后会自动读取。')).toBeTruthy();
  });
});
