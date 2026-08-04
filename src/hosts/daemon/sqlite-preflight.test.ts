import { describe, expect, it, vi } from 'vitest';

import { preflightNodeNativeSqlite, SqliteAbiPreflightError } from './sqlite-preflight';

const nodeRuntime = { node: '22.22.3', modules: '127' };

describe('Node-native SQLite ABI preflight', () => {
  it('loads the injected daemon artifact against an in-memory probe only', () => {
    const opened: string[] = [];
    const close = vi.fn();
    class Database {
      constructor(filename: string) {
        opened.push(filename);
      }

      close(): void {
        close();
      }
    }

    expect(
      preflightNodeNativeSqlite({ loadModule: () => Database, runtimeVersions: nodeRuntime }),
    ).toEqual({
      moduleName: 'better-sqlite3',
      runtimeNodeVersion: '22.22.3',
      runtimeAbi: '127',
      probeDatabase: ':memory:',
    });
    expect(opened).toEqual([':memory:']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('surfaces native ABI load failures instead of treating Electron mismatch as success', () => {
    class MismatchedDatabase {
      constructor(_filename: string) {
        throw new Error(
          'NODE_MODULE_VERSION 130. This version of Node.js requires NODE_MODULE_VERSION 127',
        );
      }
    }

    expect(() =>
      preflightNodeNativeSqlite({
        loadModule: () => MismatchedDatabase,
        runtimeVersions: nodeRuntime,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SqliteAbiPreflightError>>({
        code: 'native_load_failed',
      }),
    );
  });

  it('rejects Electron runtimes before loading any artifact', () => {
    const loadModule = vi.fn();
    expect(() =>
      preflightNodeNativeSqlite({
        loadModule,
        runtimeVersions: { ...nodeRuntime, electron: '33.4.11' },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SqliteAbiPreflightError>>({ code: 'electron_runtime' }),
    );
    expect(loadModule).not.toHaveBeenCalled();
  });
});
