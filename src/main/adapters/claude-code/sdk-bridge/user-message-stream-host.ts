import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { ClaudeUserMessageStreamHost } from './user-message-stream-core';

export const desktopClaudeUserMessageStreamHost: ClaudeUserMessageStreamHost = {
  readAttachmentBase64: async (path) => (await fsp.readFile(path)).toString('base64'),
  createProviderMessageId: () => randomUUID(),
  now: () => Date.now(),
};
