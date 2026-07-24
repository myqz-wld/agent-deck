// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  SessionModelFields,
  thinkingOptionsForAdapter,
} from '../SessionModelFields';

afterEach(cleanup);

describe('SessionModelFields', () => {
  it('按 adapter 展示合法思考档位，并始终保留 provider 默认选项', () => {
    expect(thinkingOptionsForAdapter('codex-cli').map((option) => option.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(thinkingOptionsForAdapter('claude-code').map((option) => option.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(thinkingOptionsForAdapter('grok-build').map((option) => option.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('模型使用自由文本，思考程度通过下拉选择', () => {
    const onModelChange = vi.fn();
    const onThinkingChange = vi.fn();
    render(
      <SessionModelFields
        adapterId="codex-cli"
        model=""
        thinking=""
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'gpt-custom-preview' },
    });
    expect(onModelChange).toHaveBeenCalledWith('gpt-custom-preview');

    fireEvent.click(screen.getByLabelText('思考程度'));
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));
    expect(onThinkingChange).toHaveBeenCalledWith('ultra');
  });
});
