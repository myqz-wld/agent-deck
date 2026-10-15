import type { AgentEvent } from '@shared/types';
import type { SessionComponentAction } from '@shared/session-component-refresh';
import type { InternalSession as ClaudeSession } from '../claude-code/sdk-bridge/types';
import type { InternalSession as CodexSession } from '../codex-cli/sdk-bridge/types';
import type { CodexAppServerClient } from '../codex-cli/app-server/client';
import { claudeRefreshGate, codexRefreshGate, grokRefreshGate } from './provider-gates';
import { applyClaudeComponentRefresh, type ClaudeRefreshTarget } from './claude';
import { applyCodexComponentRefresh, type CodexRefreshTarget } from './codex';
import { assertComponentRefreshAvailable } from './runtime-mutation';
import { buildGrokMcpServers } from '../grok-build/session-setup';
import type { GrokRuntime } from '../grok-build/runtime-types';
import type { GrokBuildBridgeOptions } from '../grok-build/bridge-options';
import { applyGrokComponentRefresh } from './grok';

export function requestClaudeRefresh(
  sessions: ReadonlyMap<string, ClaudeSession>, sessionId: string, action: SessionComponentAction,
  emit: (event: AgentEvent) => void, capture?: (sessionId: string) => ClaudeRefreshTarget,
) {
  const session = sessions.get(sessionId);
  if (!session?.cliSessionId || session.expectedClose || session.retireRequested
    || session.providerInputClosed || session.cwdTransitionGeneration != null) throw new Error('会话未就绪或正在切换，无法刷新扩展。');
  assertComponentRefreshAvailable(session);
  const gate = claudeRefreshGate(session, () => sessions.get(sessionId) === session, emit);
  if (action === 'cancel') return gate.cancel();
  if (!capture) throw new Error('当前宿主未提供扩展刷新接口。');
  return gate.request(applyClaudeComponentRefresh(session, capture(sessionId)));
}

export function requestCodexRefresh(
  sessions: ReadonlyMap<string, CodexSession>, clients: ReadonlyMap<string, CodexAppServerClient>,
  sessionId: string, action: SessionComponentAction, emit: (event: AgentEvent) => void,
  wake: (session: CodexSession) => void, capture?: (sessionId: string) => CodexRefreshTarget,
) {
  const session = sessions.get(sessionId); const client = clients.get(sessionId);
  if (!session?.threadId || !client || session.intentionallyClosed || session.retireAfterCurrentTurn
    || session.cwdTransitionGeneration != null) throw new Error('会话未就绪或正在切换，无法刷新扩展。');
  assertComponentRefreshAvailable(session);
  const generation = client.generation;
  const gate = codexRefreshGate(session, () => sessions.get(sessionId) === session
    && clients.get(sessionId) === client && client.generation === generation, emit,
    () => { if (!session.turnLoopRunning && !session.intentionallyClosed && session.pendingTurns.length) wake(session); },
    () => !client.hasActiveComponentConsumers);
  client.componentRefreshCheckpoint = () => { void gate.checkpoint(); };
  if (action === 'cancel') return gate.cancel();
  if (!capture) throw new Error('当前宿主未提供扩展刷新接口。');
  return gate.request(applyCodexComponentRefresh(session, client, capture(sessionId), generation));
}

export function requestGrokRefresh(
  runtimes: ReadonlyMap<string, GrokRuntime>, sessionId: string, action: SessionComponentAction,
  options: GrokBuildBridgeOptions, wake: (runtime: GrokRuntime) => void,
) {
  const runtime = runtimes.get(sessionId);
  if (!runtime?.ready || runtime.closed || runtime.disposed || runtime.sealed || runtime.restartingSandbox
    || runtime.runtimeMutationInProgress || runtime.cwdTransitionGeneration != null) throw new Error('会话未就绪或正在切换，无法刷新扩展。');
  assertComponentRefreshAvailable(runtime);
  const gate = grokRefreshGate(runtime, () => runtimes.get(sessionId) === runtime, options.emit, () => wake(runtime));
  if (action === 'cancel') return gate.cancel();
  const servers = runtime.componentMcp?.allowed ? buildGrokMcpServers(sessionId, options) : [];
  return gate.request(applyGrokComponentRefresh(runtime, servers));
}
