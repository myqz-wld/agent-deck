import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { refreshBrowserRuntimeSession } from '@main/browser-use/browser-runtime-context-host';
import type { ClaudeUserMessageStreamHost } from './user-message-stream-core';

export const desktopClaudeUserMessageStreamHost: ClaudeUserMessageStreamHost = {
  readAttachmentBase64: async (path) => (await fsp.readFile(path)).toString('base64'),
  createProviderMessageId: () => randomUUID(),
  refreshBrowserRuntime: refreshBrowserRuntimeSession,
  now: () => Date.now(),
};
