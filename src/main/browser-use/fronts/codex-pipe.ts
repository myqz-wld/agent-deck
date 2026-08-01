/**
 * Codex Browser plugin front.
 *
 * Everything in this file exists only to satisfy the OpenAI Browser client's private contract:
 * discovery metadata, the first-request session binding, synthetic top-level CDP targets, and the
 * request stubs the client probes for. Real browser work belongs to `../engine/*`, which knows
 * nothing about Codex.
 *
 * Keep upstream-shaped quirks here. When the Browser plugin contract drifts, this file is the only
 * one that should need to change.
 */

import { app } from 'electron';

import {
  BrowserEngine,
  getBrowserEngine,
  type BrowserOwnerHandle,
  type BrowserOwnerLease,
} from '../engine/registry';
import { CDP_TIMEOUT_MS, type TabInfo } from '../engine/types';
import type { EngineTab } from '../engine/tab';

export interface BrowserUseNotifier {
  notify(method: string, params: unknown): void;
}

export interface CodexPipeBrowserFrontOptions {
  appVersion?: string;
  codexAppBuildFlavor?: string;
  createWindow?: BrowserEngine['createWindow'];
  engine?: BrowserEngine;
  showWindows?: boolean;
}

type UnknownRecord = Record<string, unknown>;

interface TabTargets {
  targetIdsBySessionId: Map<string, string>;
  targetSessionsById: Map<string, string>;
  subscribed: boolean;
  unsubscribe: Array<() => void>;
}

export class CodexPipeBrowserFront {
  private readonly engine: BrowserEngine;
  private readonly appVersion: string;
  private readonly codexAppBuildFlavor: string;
  private readonly showWindows: boolean;
  private readonly targets = new Map<number, TabTargets>();
  private boundSessionId: string | null = null;
  private lease: BrowserOwnerLease | null = null;
  private unsubscribeTabClosed: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly notifier: BrowserUseNotifier,
    options: CodexPipeBrowserFrontOptions = {},
  ) {
    // An injected window factory means a caller-owned engine (tests, isolated harnesses). Production
    // uses the shared engine so tab caps are global across fronts.
    this.engine = options.engine
      ?? (options.createWindow == null
        ? getBrowserEngine()
        : new BrowserEngine({ createWindow: options.createWindow }));
    this.appVersion = options.appVersion ?? app.getVersion();
    this.codexAppBuildFlavor =
      options.codexAppBuildFlavor ??
      (process.env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR?.trim() || 'prod');
    this.showWindows = options.showWindows ?? true;
  }

  async handleRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = asRecord(rawParams);
    if (method !== 'ping') this.bindAndValidateSession(params);

    switch (method) {
      case 'ping':
        return 'pong';
      case 'getInfo':
        return this.getInfo();
      case 'getTabs':
        return this.listTabInfos();
      case 'getUserTabs':
        return [];
      case 'getUserHistory':
      case 'claimUserTab':
        throw new Error(`${method} is not supported by the Agent Deck browser.`);
      case 'createTab':
        return this.createTab();
      case 'attach':
        return this.attach(requireTabId(params));
      case 'attachTarget':
        return this.attachTarget(requireTabId(params), requireString(params, 'targetId'));
      case 'detach':
        return this.detach(requireTabId(params));
      case 'detachTarget':
        return this.detachTarget(requireTabId(params), requireString(params, 'targetId'));
      case 'executeCdp':
        return this.executeCdp(params);
      case 'allowDownload':
      case 'markTab':
      case 'moveMouse':
      case 'nameSession':
      case 'turnEnded':
        return {};
      case 'finalizeTabs':
        return this.finalizeTabs(params);
      default:
        throw new Error(`No handler registered for method: ${method}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const unsubscribeTabClosed = this.unsubscribeTabClosed;
    this.unsubscribeTabClosed = null;
    unsubscribeTabClosed?.();
    for (const tabId of [...this.targets.keys()]) this.disposeTarget(tabId);
    const lease = this.lease;
    this.lease = null;
    await lease?.release();
  }

  private bindAndValidateSession(params: UnknownRecord): void {
    const sessionId = requireString(params, 'session_id');
    if (this.boundSessionId == null) {
      this.boundSessionId = sessionId;
      const lease = this.engine.acquireLease({
        kind: 'codex-pipe',
        id: sessionId,
      });
      this.lease = lease;
      this.unsubscribeTabClosed = lease.handle.onTabClosed((tabId) => {
        this.disposeTarget(tabId);
      });
      return;
    }
    if (this.boundSessionId !== sessionId) {
      throw new Error('Browser-use connection cannot switch Codex sessions.');
    }
  }

  private getInfo(): UnknownRecord {
    return {
      name: 'Agent Deck In-app Browser',
      version: this.appVersion,
      type: 'iab',
      capabilities: {
        browser: [],
        tab: [],
      },
      metadata: {
        codexAppBuildFlavor: this.codexAppBuildFlavor,
        codexSessionId: this.requireBoundSessionId(),
      },
    };
  }

  private async createTab(): Promise<UnknownRecord> {
    if (this.disposed) throw new Error('Browser-use session is closed.');
    const handle = this.requireHandle();
    const tab = await handle.openTab({ show: this.showWindows });
    this.tabTargets(tab.id);
    this.pruneTargets(handle);
    return { ...tab.info(handle.isActive(tab.id)) };
  }

  private async attach(tabId: number): Promise<UnknownRecord> {
    const tab = this.requireHandle().requireTab(tabId);
    tab.cdp.attach();
    this.subscribe(tab);
    return {};
  }

  private async detach(tabId: number): Promise<UnknownRecord> {
    const tab = this.requireHandle().requireTab(tabId);
    tab.cdp.detach();
    const targets = this.tabTargets(tabId);
    targets.targetIdsBySessionId.clear();
    targets.targetSessionsById.clear();
    return {};
  }

  private async attachTarget(tabId: number, targetId: string): Promise<UnknownRecord> {
    const tab = this.requireHandle().requireTab(tabId);
    await this.attach(tabId);
    const targets = this.tabTargets(tabId);
    if (targetId === syntheticTargetId(tabId) || targets.targetSessionsById.has(targetId)) return {};
    const result = await tab.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = isRecord(result) ? result.sessionId : null;
    if (typeof sessionId !== 'string') {
      throw new Error('Target.attachToTarget did not return a sessionId.');
    }
    this.rememberTargetSession(tabId, targetId, sessionId);
    return {};
  }

  private async detachTarget(tabId: number, targetId: string): Promise<UnknownRecord> {
    const tab = this.requireHandle().requireTab(tabId);
    if (targetId === syntheticTargetId(tabId)) return this.detach(tabId);
    const targets = this.tabTargets(tabId);
    const sessionId = targets.targetSessionsById.get(targetId);
    if (sessionId == null) return {};
    try {
      await tab.cdp.send('Target.detachFromTarget', { sessionId });
    } finally {
      this.forgetTargetSession(tabId, sessionId);
    }
    return {};
  }

  private async executeCdp(params: UnknownRecord): Promise<unknown> {
    const target = asRecord(params.target);
    const method = requireString(params, 'method');
    const handle = this.requireHandle();
    const commandParams = isRecord(params.commandParams) ? params.commandParams : {};
    if (method === 'Target.closeTarget') {
      return this.closeSyntheticTarget(requireString(commandParams, 'targetId'));
    }
    const tabId = optionalPositiveInteger(target.tabId) ?? (await this.ensureTabForCdp(method));
    if (method === 'Page.close') {
      this.closePage(tabId);
      return {};
    }

    const tab = handle.requireTab(tabId);
    await this.attach(tabId);
    if (method === 'Target.getTargets') return this.getTargetInfos(tab);

    const explicitSessionId = typeof target.sessionId === 'string' ? target.sessionId : undefined;
    const targetId = typeof target.targetId === 'string' ? target.targetId : undefined;
    const targets = this.tabTargets(tabId);
    const targetSessionId =
      targetId == null || targetId === syntheticTargetId(tabId)
        ? undefined
        : targets.targetSessionsById.get(targetId);
    if (targetId != null && targetId !== syntheticTargetId(tabId) && targetSessionId == null) {
      throw new Error(`No debugger session is attached for target ${targetId}.`);
    }
    return tab.cdp.send(
      method,
      commandParams,
      explicitSessionId ?? targetSessionId,
      optionalPositiveInteger(params.timeoutMs) ?? CDP_TIMEOUT_MS,
    );
  }

  /**
   * Electron's debugger exposes no top-level page target, so each tab is advertised as a synthetic
   * `page` target and merged with the real child targets the debugger does report.
   */
  private async getTargetInfos(tab: EngineTab): Promise<UnknownRecord> {
    const handle = this.requireHandle();
    this.pruneTargets(handle);
    const nativeResult = await tab.cdp.send('Target.getTargets', {});
    const nativeTargets =
      isRecord(nativeResult) && Array.isArray(nativeResult.targetInfos)
        ? nativeResult.targetInfos.filter((candidate) => {
            if (!isRecord(candidate)) return false;
            return candidate.type === 'iframe' || candidate.type === 'other';
          })
        : [];
    const topLevelTargets = handle.listTabs().map((candidate) => ({
      attached: true,
      canAccessOpener: false,
      id: syntheticTargetId(candidate.id),
      targetId: syntheticTargetId(candidate.id),
      tabId: candidate.id,
      title: candidate.title(),
      url: candidate.url(),
      type: 'page',
    }));
    return { targetInfos: [...topLevelTargets, ...nativeTargets] };
  }

  private closeSyntheticTarget(targetId: string): UnknownRecord {
    const tabId = parseSyntheticTargetId(targetId);
    if (tabId == null) throw new Error(`Unknown browser target: ${targetId}`);
    const handle = this.requireHandle();
    const tab = handle.getTab(tabId);
    try {
      tab?.close();
    } finally {
      this.pruneTargets(handle);
      if (tab == null) this.disposeTarget(tabId);
    }
    return { success: true };
  }

  private closePage(tabId: number): void {
    const handle = this.requireHandle();
    const tab = handle.getTab(tabId);
    try {
      tab?.close();
    } finally {
      this.pruneTargets(handle);
      if (tab == null) this.disposeTarget(tabId);
    }
  }

  private finalizeTabs(params: UnknownRecord): UnknownRecord {
    const keep = Array.isArray(params.keep) ? params.keep : [];
    const keepIds = keep.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const tabId = optionalPositiveInteger(entry.tabId);
      return tabId == null ? [] : [tabId];
    });
    const handle = this.requireHandle();
    this.pruneTargets(handle);
    try {
      handle.keepOnly(keepIds);
    } finally {
      this.pruneTargets(handle);
    }
    return {};
  }

  private listTabInfos(): TabInfo[] {
    const handle = this.requireHandle();
    this.pruneTargets(handle);
    return handle.listTabInfos();
  }

  private async ensureTabForCdp(method: string): Promise<number> {
    const existing = this.requireHandle().listTabs()[0];
    if (existing != null) return existing.id;
    if (method !== 'Page.navigate') {
      throw new Error('executeCdp requires a tabId target.');
    }
    const created = await this.createTab();
    return requirePositiveInteger(created.id, 'tab id');
  }

  private subscribe(tab: EngineTab): void {
    const targets = this.tabTargets(tab.id);
    if (targets.subscribed) return;
    targets.subscribed = true;

    const offMessage = tab.cdp.onMessage((method, params, cdpSessionId) => {
      if (method === 'Target.attachedToTarget') {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
        const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : null;
        const targetId =
          targetInfo != null && typeof targetInfo.targetId === 'string' ? targetInfo.targetId : null;
        if (sessionId != null && targetId != null) {
          this.rememberTargetSession(tab.id, targetId, sessionId);
        }
      } else if (method === 'Target.detachedFromTarget') {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
        if (sessionId != null) this.forgetTargetSession(tab.id, sessionId);
      }
      const targetId =
        cdpSessionId == null ? undefined : this.tabTargets(tab.id).targetIdsBySessionId.get(cdpSessionId);
      this.notifier.notify('onCDPEvent', {
        source: {
          tabId: tab.id,
          ...(cdpSessionId == null ? {} : { sessionId: cdpSessionId }),
          ...(targetId == null ? {} : { targetId }),
        },
        method,
        params,
      });
    });
    const offDetach = tab.cdp.onDetach((reason) => {
      const current = this.tabTargets(tab.id);
      current.targetIdsBySessionId.clear();
      current.targetSessionsById.clear();
      this.notifier.notify('onCDPDetach', { tabId: tab.id, reason });
    });
    targets.unsubscribe.push(offMessage, offDetach);
  }

  private tabTargets(tabId: number): TabTargets {
    let targets = this.targets.get(tabId);
    if (targets == null) {
      targets = {
        targetIdsBySessionId: new Map(),
        targetSessionsById: new Map(),
        subscribed: false,
        unsubscribe: [],
      };
      this.targets.set(tabId, targets);
    }
    return targets;
  }

  private disposeTarget(tabId: number): void {
    const targets = this.targets.get(tabId);
    if (targets == null) return;
    this.targets.delete(tabId);
    targets.targetIdsBySessionId.clear();
    targets.targetSessionsById.clear();
    targets.subscribed = false;
    for (const unsubscribe of targets.unsubscribe.splice(0)) unsubscribe();
  }

  private pruneTargets(handle: BrowserOwnerHandle): void {
    const liveTabIds = new Set(handle.listTabs().map((tab) => tab.id));
    for (const tabId of [...this.targets.keys()]) {
      if (!liveTabIds.has(tabId)) this.disposeTarget(tabId);
    }
  }

  private rememberTargetSession(tabId: number, targetId: string, sessionId: string): void {
    const targets = this.tabTargets(tabId);
    targets.targetSessionsById.set(targetId, sessionId);
    targets.targetIdsBySessionId.set(sessionId, targetId);
  }

  private forgetTargetSession(tabId: number, sessionId: string): void {
    const targets = this.tabTargets(tabId);
    const targetId = targets.targetIdsBySessionId.get(sessionId);
    targets.targetIdsBySessionId.delete(sessionId);
    if (targetId != null) targets.targetSessionsById.delete(targetId);
  }

  private requireHandle(): BrowserOwnerHandle {
    if (this.disposed) throw new Error('Browser-use session is closed.');
    const handle = this.lease?.handle;
    if (handle == null) throw new Error('Browser-use session is not initialized.');
    if (handle.isDisposed) throw new Error('Browser-use session is closed.');
    return handle;
  }

  private requireBoundSessionId(): string {
    if (this.boundSessionId == null) throw new Error('Browser-use session is not initialized.');
    return this.boundSessionId;
  }
}

function syntheticTargetId(tabId: number): string {
  return `agent-deck-iab-tab:${tabId}`;
}

function parseSyntheticTargetId(targetId: string): number | null {
  const match = /^agent-deck-iab-tab:([1-9]\d*)$/.exec(targetId);
  return match == null ? null : optionalPositiveInteger(Number(match[1]));
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Browser-use request requires ${key}.`);
  }
  return value;
}

function requireTabId(record: UnknownRecord): number {
  return requirePositiveInteger(record.tabId, 'tabId');
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = optionalPositiveInteger(value);
  if (parsed == null) throw new Error(`Browser-use request requires a positive ${label}.`);
  return parsed;
}

function optionalPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
