import type { JSX } from 'react';
import {
  ConventionDocumentEditor,
  type ConventionDocumentEditorConfig,
} from './b18/ConventionDocumentEditor';

const GROK_BUILD_CONFIG: ConventionDocumentEditorConfig = {
  adapter: 'grok-build',
  adapterName: 'Grok Build',
  fileName: 'GROK_AGENTS.md',
  description: '内容会随新建的 Grok Build 会话加载，不会写入用户级 Grok Build 配置。',
  saveHint: '已保存。下次新建 Grok Build 会话时生效。',
  resetHint: '已恢复默认。下次新建 Grok Build 会话时生效。',
  resetDetail: '只删除 Agent Deck userData 中的副本，不会修改 ~/.grok 下的任何文件。',
  load: () => window.api.getGrokAgentsMd(),
  save: (content) => window.api.saveGrokAgentsMd(content),
  reset: () => window.api.resetGrokAgentsMd(),
};

export interface GrokAgentsMdEditorProps {
  onDirtyChange?: (dirty: boolean) => void;
}

export function GrokAgentsMdEditor({
  onDirtyChange,
}: GrokAgentsMdEditorProps): JSX.Element {
  return (
    <ConventionDocumentEditor
      config={GROK_BUILD_CONFIG}
      onDirtyChange={onDirtyChange}
    />
  );
}
