import { createHash } from 'node:crypto';

import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Event,
} from 'electron';

export interface BrowserUseNotifier {
  notify(method: string, params: unknown): void;
}

export interface IabBrowserSessionOptions {
  appVersion?: string;
  codexAppBuildFlavor?: string;
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  showWindows?: boolean;
}

interface BrowserTab {
  id: number;
  window: BrowserWindow;
  targetIdsBySessionId: Map<string, string>;
  targetSessionsById: Map<string, string>;
  debuggerListenersInstalled: boolean;
}

type UnknownRecord = Record<string, unknown>;

const INITIAL_URL = 'about:blank';
const CDP_TIMEOUT_MS = 20_000;

export class IabBrowserSession {
  private readonly tabs = new Map<number, BrowserTab>();
  private readonly createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  private readonly appVersion: string;
  private readonly codexAppBuildFlavor: string;
  private readonly showWindows: boolean;
  private boundSessionId: string | null = null;
  private activeTabId: number | null = null;
  private nextTabId = 1;
  private disposed = false;

  constructor(
    private readonly notifier: BrowserUseNotifier,
    options: IabBrowserSessionOptions = {},
  ) {
    this.createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
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
        return this.getTabs();
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
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    this.activeTabId = null;
    for (const tab of tabs) {
      if (!tab.window.isDestroyed()) tab.window.destroy();
    }
  }

  private bindAndValidateSession(params: UnknownRecord): void {
    const sessionId = requireString(params, 'session_id');
    if (this.boundSessionId == null) {
      this.boundSessionId = sessionId;
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
        agentDeckSessionOwned: 'true',
      },
    };
  }

  private getTabs(): UnknownRecord[] {
    this.pruneDestroyedTabs();
    const firstTabId = this.tabs.keys().next().value as number | undefined;
    if (this.activeTabId == null || !this.tabs.has(this.activeTabId)) {
      this.activeTabId = firstTabId ?? null;
    }
    return [...this.tabs.values()].map((tab) => this.serializeTab(tab));
  }

  private async createTab(): Promise<UnknownRecord> {
    if (this.disposed) throw new Error('Browser-use session is closed.');
    const tabId = this.nextTabId++;
    const window = this.createWindow({
      width: 1280,
      height: 900,
      show: false,
      autoHideMenuBar: true,
      title: 'Agent Deck In-app Browser',
      webPreferences: {
        partition: this.partitionName(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    const tab: BrowserTab = {
      id: tabId,
      window,
      targetIdsBySessionId: new Map(),
      targetSessionsById: new Map(),
      debuggerListenersInstalled: false,
    };
    this.tabs.set(tabId, tab);
    this.activeTabId = tabId;

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('focus', () => {
      if (this.tabs.has(tabId)) this.activeTabId = tabId;
    });
    window.on('closed', () => {
      this.tabs.delete(tabId);
      if (this.activeTabId === tabId) this.activeTabId = null;
    });
    await window.loadURL(INITIAL_URL);
    if (this.showWindows && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
    return this.serializeTab(tab);
  }

  private serializeTab(tab: BrowserTab): UnknownRecord {
    const destroyed = tab.window.isDestroyed();
    return {
      id: tab.id,
      title: destroyed ? '' : tab.window.webContents.getTitle(),
      url: destroyed ? '' : tab.window.webContents.getURL() || INITIAL_URL,
      active: tab.id === this.activeTabId,
    };
  }

  private async attach(tabId: number): Promise<UnknownRecord> {
    const tab = this.requireTab(tabId);
    const { debugger: browserDebugger } = tab.window.webContents;
    if (!browserDebugger.isAttached()) {
      try {
        browserDebugger.attach('1.3');
      } catch (error) {
        if (!String(error).includes('already attached')) throw error;
      }
    }
    this.installDebuggerListeners(tab);
    return {};
  }

  private async detach(tabId: number): Promise<UnknownRecord> {
    const tab = this.requireTab(tabId);
    if (tab.window.webContents.debugger.isAttached()) {
      tab.window.webContents.debugger.detach();
    }
    tab.targetIdsBySessionId.clear();
    tab.targetSessionsById.clear();
    return {};
  }

  private async attachTarget(tabId: number, targetId: string): Promise<UnknownRecord> {
    const tab = this.requireTab(tabId);
    await this.attach(tabId);
    if (targetId === syntheticTargetId(tabId) || tab.targetSessionsById.has(targetId)) return {};
    const result = await this.sendDebuggerCommand(tab, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = isRecord(result) ? result.sessionId : null;
    if (typeof sessionId !== 'string') {
      throw new Error('Target.attachToTarget did not return a sessionId.');
    }
    this.rememberTargetSession(tab, targetId, sessionId);
    return {};
  }

  private async detachTarget(tabId: number, targetId: string): Promise<UnknownRecord> {
    const tab = this.requireTab(tabId);
    if (targetId === syntheticTargetId(tabId)) return this.detach(tabId);
    const sessionId = tab.targetSessionsById.get(targetId);
    if (sessionId == null) return {};
    try {
      await this.sendDebuggerCommand(tab, 'Target.detachFromTarget', { sessionId });
    } finally {
      this.forgetTargetSession(tab, sessionId);
    }
    return {};
  }

  private async executeCdp(params: UnknownRecord): Promise<unknown> {
    const target = asRecord(params.target);
    const method = requireString(params, 'method');
    const tabId = optionalPositiveInteger(target.tabId) ?? (await this.ensureTabForCdp(method));
    const tab = this.requireTab(tabId);
    await this.attach(tabId);

    const commandParams = isRecord(params.commandParams) ? params.commandParams : {};
    if (method === 'Target.getTargets') return this.getTargetInfos(tab);
    if (method === 'Target.closeTarget') {
      return this.closeSyntheticTarget(requireString(commandParams, 'targetId'));
    }
    if (method === 'Page.close') {
      tab.window.close();
      return {};
    }

    const explicitSessionId =
      typeof target.sessionId === 'string' ? target.sessionId : undefined;
    const targetId = typeof target.targetId === 'string' ? target.targetId : undefined;
    const targetSessionId =
      targetId == null || targetId === syntheticTargetId(tabId)
        ? undefined
        : tab.targetSessionsById.get(targetId);
    if (targetId != null && targetId !== syntheticTargetId(tabId) && targetSessionId == null) {
      throw new Error(`No debugger session is attached for target ${targetId}.`);
    }
    return this.sendDebuggerCommand(
      tab,
      method,
      commandParams,
      explicitSessionId ?? targetSessionId,
      optionalPositiveInteger(params.timeoutMs) ?? CDP_TIMEOUT_MS,
    );
  }

  private async getTargetInfos(tab: BrowserTab): Promise<UnknownRecord> {
    const nativeResult = await this.sendDebuggerCommand(tab, 'Target.getTargets', {});
    const nativeTargets =
      isRecord(nativeResult) && Array.isArray(nativeResult.targetInfos)
        ? nativeResult.targetInfos.filter((target) => {
            if (!isRecord(target)) return false;
            return target.type === 'iframe' || target.type === 'other';
          })
        : [];
    const topLevelTargets = [...this.tabs.values()].map((candidate) => ({
      attached: true,
      canAccessOpener: false,
      id: syntheticTargetId(candidate.id),
      targetId: syntheticTargetId(candidate.id),
      tabId: candidate.id,
      title: candidate.window.isDestroyed() ? '' : candidate.window.webContents.getTitle(),
      type: 'page',
      url: candidate.window.isDestroyed()
        ? ''
        : candidate.window.webContents.getURL() || INITIAL_URL,
    }));
    return { targetInfos: [...topLevelTargets, ...nativeTargets] };
  }

  private closeSyntheticTarget(targetId: string): UnknownRecord {
    const tab = [...this.tabs.values()].find(
      (candidate) => syntheticTargetId(candidate.id) === targetId,
    );
    if (tab == null) throw new Error(`Unknown browser target: ${targetId}`);
    tab.window.close();
    return { success: true };
  }

  private finalizeTabs(params: UnknownRecord): UnknownRecord {
    const keep = Array.isArray(params.keep) ? params.keep : [];
    const keepIds = new Set(
      keep.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const tabId = optionalPositiveInteger(entry.tabId);
        return tabId == null ? [] : [tabId];
      }),
    );
    for (const tab of [...this.tabs.values()]) {
      if (!keepIds.has(tab.id)) tab.window.close();
    }
    return {};
  }

  private installDebuggerListeners(tab: BrowserTab): void {
    if (tab.debuggerListenersInstalled) return;
    tab.debuggerListenersInstalled = true;
    const browserDebugger = tab.window.webContents.debugger;
    browserDebugger.on(
      'message',
      (
        _event: Event,
        method: string,
        params: UnknownRecord,
        debuggerSessionId?: string,
      ) => {
        const eventSessionId = debuggerSessionId || undefined;
        if (method === 'Target.attachedToTarget') {
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
          const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : null;
          const targetId =
            targetInfo != null && typeof targetInfo.targetId === 'string'
              ? targetInfo.targetId
              : null;
          if (sessionId != null && targetId != null) {
            this.rememberTargetSession(tab, targetId, sessionId);
          }
        } else if (method === 'Target.detachedFromTarget') {
          const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
          if (sessionId != null) this.forgetTargetSession(tab, sessionId);
        }
        const targetId =
          eventSessionId == null ? undefined : tab.targetIdsBySessionId.get(eventSessionId);
        this.notifier.notify('onCDPEvent', {
          source: {
            tabId: tab.id,
            ...(eventSessionId == null ? {} : { sessionId: eventSessionId }),
            ...(targetId == null ? {} : { targetId }),
          },
          method,
          params,
        });
      },
    );
    browserDebugger.on('detach', (_event: Event, reason: string) => {
      tab.targetIdsBySessionId.clear();
      tab.targetSessionsById.clear();
      this.notifier.notify('onCDPDetach', { tabId: tab.id, reason });
    });
  }

  private async sendDebuggerCommand(
    tab: BrowserTab,
    method: string,
    params: UnknownRecord,
    debuggerSessionId?: string,
    timeoutMs = CDP_TIMEOUT_MS,
  ): Promise<unknown> {
    const command = tab.window.webContents.debugger.sendCommand(
      method,
      params,
      debuggerSessionId,
    );
    return withTimeout(command, timeoutMs, `CDP command timed out: ${method}`);
  }

  private async ensureTabForCdp(method: string): Promise<number> {
    const firstTabId = this.tabs.keys().next().value as number | undefined;
    if (firstTabId != null) return firstTabId;
    if (method !== 'Page.navigate') {
      throw new Error('executeCdp requires a tabId target.');
    }
    const created = await this.createTab();
    return requirePositiveInteger(created.id, 'tab id');
  }

  private rememberTargetSession(tab: BrowserTab, targetId: string, sessionId: string): void {
    tab.targetSessionsById.set(targetId, sessionId);
    tab.targetIdsBySessionId.set(sessionId, targetId);
  }

  private forgetTargetSession(tab: BrowserTab, sessionId: string): void {
    const targetId = tab.targetIdsBySessionId.get(sessionId);
    tab.targetIdsBySessionId.delete(sessionId);
    if (targetId != null) tab.targetSessionsById.delete(targetId);
  }

  private requireTab(tabId: number): BrowserTab {
    this.pruneDestroyedTabs();
    const tab = this.tabs.get(tabId);
    if (tab == null) throw new Error(`Unknown tab: ${tabId}`);
    return tab;
  }

  private pruneDestroyedTabs(): void {
    for (const [tabId, tab] of this.tabs) {
      if (tab.window.isDestroyed()) this.tabs.delete(tabId);
    }
  }

  private partitionName(): string {
    const digest = createHash('sha256')
      .update(this.requireBoundSessionId())
      .digest('hex')
      .slice(0, 20);
    return `agent-deck-browser-${digest}`;
  }

  private requireBoundSessionId(): string {
    if (this.boundSessionId == null) throw new Error('Browser-use session is not initialized.');
    return this.boundSessionId;
  }
}

function syntheticTargetId(tabId: number): string {
  return `agent-deck-iab-tab:${tabId}`;
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.min(timeoutMs, CDP_TIMEOUT_MS));
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
