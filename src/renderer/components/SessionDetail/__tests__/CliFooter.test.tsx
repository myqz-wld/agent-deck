// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CliFooter } from '../CliFooter';

describe('CliFooter', () => {
  it.each([
    ['claude-code', 'Claude'],
    ['codex-cli', 'Codex'],
    ['grok-build', 'Grok'],
    ['custom-adapter', '该 Agent'],
  ])('uses adapter-aware terminal copy for %s', (agentId, expected) => {
    const { container } = render(<CliFooter agentId={agentId} />);
    expect(container.textContent).toContain(`回到运行 ${expected} 的终端窗口`);
  });
});
