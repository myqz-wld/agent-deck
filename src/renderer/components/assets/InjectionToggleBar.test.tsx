// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { InjectionToggleBar } from './InjectionToggleBar';

afterEach(cleanup);

describe('InjectionToggleBar', () => {
  it.each([
    ['skills', 'Skills', 'injectAgentDeckClaudeSkills', 'injectAgentDeckCodexSkills'],
    ['agents', 'Agents', 'injectAgentDeckClaudeAgents', 'injectAgentDeckCodexAgents'],
    ['claude-md', '应用约定', 'injectAgentDeckClaudeMd', 'injectAgentDeckCodexAgentsMd'],
  ] as const)(
    '%s 使用统一的开关与解释模板',
    (tab, assetLabel, claudeKey, codexKey) => {
      const update = vi.fn().mockResolvedValue(undefined);
      render(<InjectionToggleBar tab={tab} settings={DEFAULT_SETTINGS} update={update} />);

      expect(screen.getByLabelText('注入到 Claude 会话')).toBeTruthy();
      expect(screen.getByLabelText('注入到 Codex 会话')).toBeTruthy();
      expect(
        screen.getByText(
          `只控制 Agent Deck 内置 ${assetLabel}；用户和项目中的同类资产不受影响。仅对新建会话生效，已运行的会话不受影响。`,
        ),
      ).toBeTruthy();

      fireEvent.click(screen.getByLabelText('注入到 Claude 会话'));
      fireEvent.click(screen.getByLabelText('注入到 Codex 会话'));
      expect(update).toHaveBeenNthCalledWith(1, { [claudeKey]: false });
      expect(update).toHaveBeenNthCalledWith(2, { [codexKey]: false });
    },
  );
});
