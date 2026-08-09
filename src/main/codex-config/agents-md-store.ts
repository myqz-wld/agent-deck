import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface CodexAgentsMdDiagnostics {
  warn(message: string, error: unknown): void;
}

export interface CodexAgentsMdStoreOptions {
  builtinPath: string;
  userPath: string;
  diagnostics?: CodexAgentsMdDiagnostics;
}

export interface CodexAgentsMdDocument {
  content: string;
  isCustom: boolean;
}

export function createCodexAgentsMdStore(options: CodexAgentsMdStoreOptions) {
  let cachedContent: string | null = null;

  const invalidate = (): void => {
    cachedContent = null;
  };

  const readContentRaw = (): string => {
    if (existsSync(options.userPath)) {
      try {
        return readFileSync(options.userPath, 'utf8');
      } catch (error) {
        options.diagnostics?.warn(
          '[codex-agents-md] failed to read custom application convention',
          error,
        );
      }
    }
    try {
      return readFileSync(options.builtinPath, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `codex-config/CODEX_AGENTS.md missing or unreadable, build/dev config error: ${detail}`,
      );
    }
  };

  const getContent = (): string => {
    if (cachedContent !== null) return cachedContent;
    cachedContent = readContentRaw();
    return cachedContent;
  };

  const getBuiltin = (): string => {
    try {
      return readFileSync(options.builtinPath, 'utf8');
    } catch (error) {
      options.diagnostics?.warn(
        '[codex-agents-md] failed to read bundled CODEX_AGENTS.md',
        error,
      );
      return '';
    }
  };

  const getActive = (): CodexAgentsMdDocument => {
    if (existsSync(options.userPath)) {
      try {
        return { content: readFileSync(options.userPath, 'utf8'), isCustom: true };
      } catch (error) {
        options.diagnostics?.warn(
          '[codex-agents-md] failed to read custom application convention',
          error,
        );
      }
    }
    return { content: getBuiltin(), isCustom: false };
  };

  const saveUser = (content: string): CodexAgentsMdDocument => {
    mkdirSync(dirname(options.userPath), { recursive: true });
    const temporaryPath = `${options.userPath}.tmp.${process.pid}`;
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, options.userPath);
    invalidate();
    return { content: readFileSync(options.userPath, 'utf8'), isCustom: true };
  };

  const resetUser = (): void => {
    if (existsSync(options.userPath)) {
      try {
        unlinkSync(options.userPath);
      } catch (error) {
        options.diagnostics?.warn(
          '[codex-agents-md] failed to remove custom application convention',
          error,
        );
        throw error;
      }
    }
    invalidate();
  };

  return Object.freeze({
    getContent,
    getActive,
    getBuiltin,
    saveUser,
    resetUser,
    invalidate,
  });
}

export type CodexAgentsMdStore = ReturnType<typeof createCodexAgentsMdStore>;
