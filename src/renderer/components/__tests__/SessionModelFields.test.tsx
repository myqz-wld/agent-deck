// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  SessionModelFields,
  thinkingOptionsForAdapter,
} from '../SessionModelFields';
import { SessionModelDisclosure } from '../SessionModelDisclosure';

afterEach(cleanup);

describe('SessionModelFields', () => {
  it('按 adapter 展示合法思考档位，通用控件保留 provider 默认选项', () => {
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

  it('新建会话可只展示具体思考档位', () => {
    expect(
      thinkingOptionsForAdapter('codex-cli', false).map((option) => option.value),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
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

  it('摘要对未设置和不可用的思考程度显示权威状态而不虚构 HIGH', () => {
    const props = {
      adapterId: 'codex-cli',
      provider: '',
      providerOptions: [],
      model: '',
      thinking: '' as const,
      onProviderChange: vi.fn(),
      onModelChange: vi.fn(),
      onThinkingChange: vi.fn(),
    };
    const view = render(<SessionModelDisclosure {...props} />);
    expect(screen.getByText(/思考：跟随运行时默认值/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('思考：HIGH');

    view.rerender(
      <SessionModelDisclosure
        {...props}
        disabledReasons={{ thinking: '当前 Worker 未提供思考档位。' }}
      />,
    );
    expect(screen.getByText(/思考：不可用/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('思考：HIGH');
  });

  it('摘要不会为 Core 禁用的 Provider 或模型虚构默认值', () => {
    render(
      <SessionModelDisclosure
        adapterId="codex-cli"
        provider=""
        providerOptions={[]}
        model=""
        thinking=""
        disabledReasons={{
          provider: '当前 Worker 不允许覆盖 Provider。',
          model: '当前 Worker 不允许覆盖模型。',
        }}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onThinkingChange={vi.fn()}
      />,
    );

    const summary = screen.getByText('模型配置').closest('summary');
    expect(summary?.textContent).toContain('Provider：不可用');
    expect(summary?.textContent).toContain('模型：不可用');
    expect(summary?.textContent).not.toContain('Provider：原生');
    expect(summary?.textContent).not.toContain('模型：配置文件');
  });
});
