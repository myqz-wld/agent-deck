import type { JSX } from 'react';
import {
  ConventionDocumentEditor,
  type ConventionDocumentEditorConfig,
} from './b18/ConventionDocumentEditor';

const CLAUDE_CODE_CONFIG: ConventionDocumentEditorConfig = {
  adapter: 'claude-code',
  adapterName: 'Claude Code',
  fileName: 'CLAUDE.md',
  description: '内容会通过 system prompt 注入新建的 Claude Code 会话，不影响已运行的会话。',
  saveHint: '已保存。下次新建 Claude Code 会话时生效。',
  resetHint: '已恢复默认。下次新建 Claude Code 会话时生效。',
  resetDetail: '只删除 Agent Deck userData 中的副本，不会修改用户或项目的 CLAUDE.md。',
  load: () => window.api.getClaudeMd(),
  save: (content) => window.api.saveClaudeMd(content),
  reset: () => window.api.resetClaudeMd(),
};

export interface ClaudeMdEditorProps {
  onDirtyChange?: (dirty: boolean) => void;
}

export function ClaudeMdEditor({
  onDirtyChange,
}: ClaudeMdEditorProps): JSX.Element {
  return (
    <ConventionDocumentEditor
      config={CLAUDE_CODE_CONFIG}
      onDirtyChange={onDirtyChange}
    />
  );
}
