import type { JSX } from 'react';
import {
  ConventionDocumentEditor,
  type ConventionDocumentEditorConfig,
} from './b18/ConventionDocumentEditor';

const CODEX_CLI_CONFIG: ConventionDocumentEditorConfig = {
  adapter: 'codex-cli',
  adapterName: 'Codex CLI',
  fileName: 'CODEX_AGENTS.md',
  description: '内容会通过 developerInstructions 注入新建的 Codex CLI 会话，不影响已运行的会话。',
  saveHint: '已保存。下次新建 Codex CLI 会话时生效。',
  resetHint: '已恢复默认。下次新建 Codex CLI 会话时生效。',
  resetDetail: '只删除 Agent Deck userData 中的副本，不会修改用户或项目的 AGENTS.md。',
  load: () => window.api.getCodexAgentsMd(),
  save: (content) => window.api.saveCodexAgentsMd(content),
  reset: () => window.api.resetCodexAgentsMd(),
};

export interface CodexAgentsMdEditorProps {
  onDirtyChange?: (dirty: boolean) => void;
}

export function CodexAgentsMdEditor({
  onDirtyChange,
}: CodexAgentsMdEditorProps): JSX.Element {
  return (
    <ConventionDocumentEditor
      config={CODEX_CLI_CONFIG}
      onDirtyChange={onDirtyChange}
    />
  );
}
