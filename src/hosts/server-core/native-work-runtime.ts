import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AgentDeckClientErrorCode, isCoreMethodGranted, isJsonValue, SessionConsoleContractError,
  parseNativeWorkListParams, parseNativeWorkDetailParams, parseNativeWorkStopParams,
  parseNativeWorkListResult, parseNativeWorkDetailResult, parseNativeWorkStopResult,
  type CoreMethod } from '@contracts/index';
import { DaemonRequestError, type DaemonCoreRuntime, type DaemonRequestInput, type DaemonRequestResult } from '@hosts/daemon';
import { createNativeWorkService, type NativeWorkServicePort, type NativeWorkServiceOptions } from '@main/session/native-work-service-core';
import type { SessionRecord } from '@shared/types';
import { projectSessionText } from './session-event-projection';

export const NATIVE_WORK_METHODS = ['session.native-work.list', 'session.native-work.details', 'session.native-work.stop'] as const;
export function createServerCoreNativeWorkRuntime(base: DaemonCoreRuntime,
  options: NativeWorkServiceOptions & { workspaceRoot: string; privateRoots: readonly string[] }) {
  return new ServerCoreNativeWorkRuntime(base, { ...options, service: createNativeWorkService(options) });
}
export class ServerCoreNativeWorkRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  constructor(private readonly base: DaemonCoreRuntime, private readonly options: {
    service: NativeWorkServicePort; session(id: string): SessionRecord | null;
    workspaceRoot: string; privateRoots: readonly string[]; canonicalizePath?: (path: string) => string;
  }) {
    this.supportedMethods = [...base.supportedMethods, ...NATIVE_WORK_METHODS];
    this.subscribe = base.subscribe?.bind(base);
  }
  start() { return this.base.start(); }
  stop(reason: string) { return this.base.stop(reason); }
  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>) { return this.base.currentRevision(...args); }
  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!(NATIVE_WORK_METHODS as readonly string[]).includes(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method)) throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    if (input.signal.aborted) throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request cancelled');
    try {
      let result: unknown;
      if (input.method === 'session.native-work.list') {
        const params = parseNativeWorkListParams(input.params); this.requireSession(params.sessionId);
        const page = await this.options.service.list(params);
        result = parseNativeWorkListResult({ ...page, tasks: page.tasks.map(task => ({ ...task,
          description: this.text(task.description),
          ...(task.summary === undefined ? {} : { summary: this.text(task.summary) }),
          ...(task.error === undefined ? {} : { error: this.text(task.error) }),
          ...(task.controlReason === undefined ? {} : { controlReason: this.text(task.controlReason) }),
        })) }, params.sessionId);
      } else if (input.method === 'session.native-work.details') {
        const params = parseNativeWorkDetailParams(input.params); this.requireSession(params.ref.sessionId);
        const page = await this.options.service.details(params);
        result = parseNativeWorkDetailResult({ ...page, records: page.records.map(record => ({ ...record, text: this.text(record.text) })) }, params.ref);
      } else {
        const { ref } = parseNativeWorkStopParams(input.params); this.requireSession(ref.sessionId);
        result = parseNativeWorkStopResult(await this.options.service.stop(ref));
      }
      if (!isJsonValue(result)) throw new Error('Native work result is not JSON-safe');
      return { result, revision: await this.base.currentRevision(input.access) };
    } catch (error) {
      if (error instanceof SessionConsoleContractError) throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
      throw error;
    }
  }
  private text(value: string): string { return projectSessionText(value, this.options); }
  private requireSession(id: string): void {
    const session = this.options.session(id);
    if (!session) throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Session not found');
    let root: string, cwd: string;
    try {
      const canonicalize = this.options.canonicalizePath ?? realpathSync;
      root = canonicalize(resolve(this.options.workspaceRoot)); cwd = canonicalize(resolve(session.cwd));
    } catch { throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Session path unavailable'); }
    const rel = relative(root, cwd);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Session outside Workspace');
  }
}
