// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { PermissionsView } from '../PermissionsView';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('PermissionsView adapter routing', () => {
  it('renders ACP-native Grok controls without scanning Claude or Codex settings', async () => {
    const scanCwdSettings = vi.fn();
    const scanCodexSettings = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { scanCwdSettings, scanCodexSettings },
    });

    render(
      <PermissionsView
        cwd="/repo"
        sessionId="grok-session"
        agentId="grok-build"
        sessionMode="plan"
      />,
    );

    expect(screen.getByText('Grok Build 当前运行权限')).toBeTruthy();
    expect(screen.getByText('计划模式')).toBeTruthy();
    expect(screen.getByText(/ACP 运行时请求/)).toBeTruthy();
    expect(screen.getByText(/提供方原生控制/)).toBeTruthy();
    expect(screen.getByText(/不读取 Claude settings\.json/)).toBeTruthy();
    await waitFor(() => {
      expect(scanCwdSettings).not.toHaveBeenCalled();
      expect(scanCodexSettings).not.toHaveBeenCalled();
    });
  });
});
