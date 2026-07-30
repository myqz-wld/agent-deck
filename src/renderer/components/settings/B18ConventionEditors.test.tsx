// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => loggerSpies },
}));

import { ClaudeMdEditor } from './ClaudeMdEditor';
import { CodexAgentsMdEditor } from './CodexAgentsMdEditor';
import { GrokAgentsMdEditor } from './GrokAgentsMdEditor';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  loggerSpies.error.mockReset();
});

describe('B18 application convention editors', () => {
  it('shares one Claude Code draft across compact and expanded editors', async () => {
    const original = '# 用户维护的内容\n\n保留尾部空格  ';
    const changed = `${original}\n新增一行`;
    const written = `${changed}\n`;
    const saveClaudeMd = vi.fn(async (_content: string) => ({
      content: written,
      isCustom: true as const,
    }));
    const resetClaudeMd = vi.fn().mockResolvedValue({
      ok: true,
      content: '# 应用内置内容\n',
    });
    const confirmDialog = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const onDirtyChange = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getClaudeMd: vi.fn().mockResolvedValue({ content: original, isCustom: true }),
        saveClaudeMd,
        resetClaudeMd,
        confirmDialog,
      },
    });

    render(<ClaudeMdEditor onDirtyChange={onDirtyChange} />);
    const compact = await screen.findByLabelText('Claude Code 应用约定');
    expect((compact as HTMLTextAreaElement).value).toBe(original);

    const trigger = screen.getByRole('button', {
      name: '展开编辑 Claude Code 应用约定',
    });
    expect(compact.className).toContain('resize-none');
    expect(compact.className).not.toContain('resize-y');
    expect(trigger.className).toContain('h-6');
    expect(trigger.className).toContain('w-6');
    expect(trigger.className).not.toContain('h-11');
    expect(trigger.className).not.toContain('w-11');
    expect(document.querySelector('[data-expandable-heavy-view]')).toBeNull();
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', {
      name: '编辑 Claude Code 应用约定',
    });
    expect(document.activeElement).toBe(dialog);
    expect(document.querySelectorAll('[data-expandable-heavy-view="custom"]')).toHaveLength(1);
    const expanded = within(dialog).getByLabelText('Claude Code 应用约定（展开编辑）');
    expect((expanded as HTMLTextAreaElement).value).toBe(original);

    fireEvent.change(expanded, { target: { value: changed } });
    expect((compact as HTMLTextAreaElement).value).toBe(changed);
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: '编辑 Claude Code 应用约定' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑 Claude Code 应用约定' })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
    expect((compact as HTMLTextAreaElement).value).toBe(changed);

    fireEvent.click(trigger);
    const reopened = screen.getByRole('dialog', {
      name: '编辑 Claude Code 应用约定',
    });
    fireEvent.click(within(reopened).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(saveClaudeMd).toHaveBeenCalledWith(changed));
    expect((within(reopened).getByLabelText(
      'Claude Code 应用约定（展开编辑）',
    ) as HTMLTextAreaElement).value).toBe(written);
    expect((compact as HTMLTextAreaElement).value).toBe(written);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    fireEvent.click(within(reopened).getByRole('button', { name: '恢复默认' }));
    await waitFor(() => expect(resetClaudeMd).toHaveBeenCalledOnce());
    expect((compact as HTMLTextAreaElement).value).toBe('# 应用内置内容\n');
  });

  it.each([
    {
      name: 'Codex CLI',
      Editor: CodexAgentsMdEditor,
      getKey: 'getCodexAgentsMd',
      saveKey: 'saveCodexAgentsMd',
      resetKey: 'resetCodexAgentsMd',
      content: '# CODEX_AGENTS.md 用户正文\n',
    },
    {
      name: 'Grok Build',
      Editor: GrokAgentsMdEditor,
      getKey: 'getGrokAgentsMd',
      saveKey: 'saveGrokAgentsMd',
      resetKey: 'resetGrokAgentsMd',
      content: '# GROK_AGENTS.md 用户正文\n',
    },
  ] as const)(
    'uses the shared editor chrome without rewriting the $name prompt body',
    async ({ name, Editor, getKey, saveKey, resetKey, content }) => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          [getKey]: vi.fn().mockResolvedValue({ content, isCustom: false }),
          [saveKey]: vi.fn(async (draft: string) => ({
            content: draft,
            isCustom: true,
          })),
          [resetKey]: vi.fn(),
          confirmDialog: vi.fn().mockResolvedValue(true),
        },
      });

      render(<Editor />);
      expect((await screen.findByLabelText(`${name} 应用约定`) as HTMLTextAreaElement).value)
        .toBe(content);
      fireEvent.click(screen.getByRole('button', {
        name: `展开编辑 ${name} 应用约定`,
      }));
      const dialog = screen.getByRole('dialog', { name: `编辑 ${name} 应用约定` });
      expect((within(dialog).getByLabelText(
        `${name} 应用约定（展开编辑）`,
      ) as HTMLTextAreaElement).value).toBe(content);
      expect((within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled)
        .toBe(true);
      expect(document.querySelectorAll('[data-expandable-heavy-view]')).toHaveLength(1);
    },
  );

  it('uses fixed retryable copy and never logs convention content or backend errors', async () => {
    const loadMarker = 'LOAD_SECRET raw-marker /private/load-path';
    const saveMarker = 'SAVE_SECRET raw-marker /private/save-path';
    const resetMarker = 'RESET_SECRET raw-marker /private/reset-path';
    const draftMarker = 'DRAFT_CONTENT_SECRET';
    const getClaudeMd = vi.fn()
      .mockRejectedValueOnce(new Error(loadMarker))
      .mockResolvedValue({ content: '# 用户正文\n', isCustom: true });
    const saveClaudeMd = vi.fn()
      .mockRejectedValueOnce(new Error(saveMarker))
      .mockImplementation(async (content: string) => ({
        content,
        isCustom: true,
      }));
    const resetClaudeMd = vi.fn()
      .mockRejectedValueOnce(new Error(resetMarker))
      .mockResolvedValue({ ok: true, content: '# 应用内置正文\n' });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getClaudeMd,
        saveClaudeMd,
        resetClaudeMd,
        confirmDialog: vi.fn().mockResolvedValue(true),
      },
    });

    render(<ClaudeMdEditor />);

    expect(await screen.findByText('读取失败，请重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(loadMarker);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    const editor = await screen.findByLabelText('Claude Code 应用约定');
    fireEvent.change(editor, {
      target: { value: `# 用户正文\n${draftMarker}\n` },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('保存失败，请重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(saveMarker);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(saveClaudeMd).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(await screen.findByText('恢复默认失败，请重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(resetMarker);

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await waitFor(() => expect(resetClaudeMd).toHaveBeenCalledTimes(2));
    expect((editor as HTMLTextAreaElement).value).toBe('# 应用内置正文\n');

    expect(loggerSpies.error).toHaveBeenCalledTimes(3);
    expect(loggerSpies.error.mock.calls.map(([, fields]) => fields)).toEqual([
      {
        action: 'load',
        adapter: 'claude-code',
        category: 'request-rejected',
        errorKind: 'object',
      },
      {
        action: 'save',
        adapter: 'claude-code',
        category: 'request-rejected',
        errorKind: 'object',
      },
      {
        action: 'reset',
        adapter: 'claude-code',
        category: 'request-rejected',
        errorKind: 'object',
      },
    ]);
    const logs = JSON.stringify(loggerSpies.error.mock.calls);
    for (const sensitive of [loadMarker, saveMarker, resetMarker, draftMarker]) {
      expect(logs).not.toContain(sensitive);
    }
  });
});
