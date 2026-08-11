// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { RemoteSessionRuntimeControls } from './RemoteSessionRuntimeControls';

afterEach(() => cleanup());

describe('RemoteSessionRuntimeControls Codex approval fallback', () => {
  it('shows never for an omitted policy without changing the sandbox fallback', () => {
    render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:session-a"
        values={{ provider: '', model: 'gpt-5.6-sol', thinking: 'low' }}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('审批').textContent).toContain('从不询问');
    expect(screen.getByLabelText('沙盒').textContent).toContain('工作目录可写');
  });

  it('preserves an explicit on-request policy', () => {
    render(
      <RemoteSessionRuntimeControls
        adapterId="codex-cli"
        busy={false}
        canWrite
        identity="remote-a:core-a:session-a"
        values={{ approvalPolicy: 'on-request' }}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('审批').textContent).toContain('按需询问');
  });
});
