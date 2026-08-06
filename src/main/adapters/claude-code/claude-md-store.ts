import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface ClaudeMdDiagnostics {
  warn(message: string, error: unknown): void;
}

export interface ClaudeMdStoreOptions {
  builtinPath: string;
  userPath: string;
  diagnostics?: ClaudeMdDiagnostics;
}

export interface ClaudeMdDocument {
  content: string;
  isCustom: boolean;
}

export function createClaudeMdStore(options: ClaudeMdStoreOptions) {
  const getBuiltin = (): string => {
    try {
      return readFileSync(options.builtinPath, 'utf8');
    } catch (error) {
      options.diagnostics?.warn(
        '[claude-md] failed to read bundled application convention',
        error,
      );
      return '';
    }
  };

  const getActive = (): ClaudeMdDocument => {
    if (existsSync(options.userPath)) {
      try {
        return { content: readFileSync(options.userPath, 'utf8'), isCustom: true };
      } catch (error) {
        options.diagnostics?.warn(
          '[claude-md] failed to read custom application convention',
          error,
        );
      }
    }
    return { content: getBuiltin(), isCustom: false };
  };

  const saveUser = (content: string): ClaudeMdDocument => {
    mkdirSync(dirname(options.userPath), { recursive: true });
    const temporaryPath = `${options.userPath}.tmp.${process.pid}`;
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, options.userPath);
    return { content: readFileSync(options.userPath, 'utf8'), isCustom: true };
  };

  const resetUser = (): void => {
    if (!existsSync(options.userPath)) return;
    try {
      unlinkSync(options.userPath);
    } catch (error) {
      options.diagnostics?.warn(
        '[claude-md] failed to remove custom application convention',
        error,
      );
      throw error;
    }
  };

  return Object.freeze({ getActive, getBuiltin, saveUser, resetUser });
}

export type ClaudeMdStore = ReturnType<typeof createClaudeMdStore>;
