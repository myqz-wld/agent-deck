// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerInput } from './ComposerInput';

afterEach(cleanup);

function renderInput(text: string, onTextChange = vi.fn(), onSubmit = vi.fn(async () => true)) {
  render(<ComposerInput
    text={text}
    placeholder="消息"
    submitLabel="发送"
    busy={false}
    canSubmit={true}
    attachments={[]}
    getAttachmentPreviewDataUrl={() => null}
    onRemoveAttachment={vi.fn()}
    onTextChange={onTextChange}
    onSubmit={onSubmit}
    commands={[{
      name: 'compact', description: '压缩上下文', argumentHint: '', aliases: ['shrink'],
    }]}
  />);
  return { onSubmit, onTextChange };
}

describe('slash command composer menu', () => {
  it('shows adapter commands and completes the canonical name by click or Tab', () => {
    const click = renderInput('/co');
    fireEvent.click(screen.getByRole('option'));
    expect(click.onTextChange).toHaveBeenCalledWith('/compact');

    cleanup();
    const tab = vi.fn();
    renderInput('/shr', tab);
    const inputs = screen.getAllByPlaceholderText('消息');
    fireEvent.keyDown(inputs.at(-1)!, { key: 'Tab' });
    expect(tab).toHaveBeenCalledWith('/compact');
  });

  it('submits an exact command on Enter', () => {
    const { onSubmit } = renderInput('/compact');
    fireEvent.keyDown(screen.getByPlaceholderText('消息'), {
      key: 'Enter', keyCode: 13,
    });
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
