import { app } from 'electron';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { adapterRegistry } from './adapters/registry';
import {
  buildCreateSessionOptions,
  isAgentId,
} from './adapters/options-builder';
import {
  resolveCreateSessionModelOptions,
  SessionModelOptionsError,
} from './adapters/session-model-options';
import { eventBus } from './event-bus';
import { getFloatingWindow } from './window';
import { sessionManager } from './session/manager';
import { agentDeckTeamRepo, TeamInvariantError } from './store/agent-deck-team-repo';
import log from '@main/utils/logger';
import type { CliInvocation } from './cli';

const logger = log.scope('main-cli');

async function resolveCwd(input: string): Promise<string> {
  // Wrappers normalize user-shell cwd when possible. This remains the direct-binary fallback.
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function applyCliInvocation(inv: CliInvocation): Promise<void> {
  if (inv.kind !== 'new-session') return;
  const adapter = adapterRegistry.get(inv.agent);
  if (!adapter?.createSession) {
    throw new Error(`agent-deck new: adapter "${inv.agent}" 不支持创建会话`);
  }
  const cwd = await resolveCwd(inv.cwd);
  if (!isAgentId(inv.agent)) {
    throw new Error(`agent-deck new: adapter "${inv.agent}" 不受支持`);
  }
  let sessionModelOptions;
  try {
    sessionModelOptions = resolveCreateSessionModelOptions(inv.agent, {
      provider: inv.agent === 'codex-cli' ? inv.profile : inv.gateway,
      model: inv.model,
      thinking: inv.thinking,
    });
  } catch (error) {
    if (error instanceof SessionModelOptionsError) {
      const field =
        error.field === 'provider'
          ? inv.agent === 'codex-cli'
            ? 'profile'
            : 'gateway'
          : error.field;
      throw new Error(`agent-deck new: --${field} ${error.message}`);
    }
    throw error;
  }
  const sid = await adapter.createSession(
    buildCreateSessionOptions(inv.agent, {
      cwd,
      prompt: inv.prompt,
      permissionMode: inv.permissionMode,
      approvalPolicy: inv.approvalPolicy,
      resume: inv.resume,
      ...sessionModelOptions,
      ...(inv.codexSandbox !== undefined ? { codexSandbox: inv.codexSandbox } : {}),
      ...(inv.grokSandbox !== undefined ? { grokSandbox: inv.grokSandbox } : {}),
    }),
  );
  if (adapter.capabilities.canSetPermissionMode) {
    sessionManager.recordCreatedPermissionMode(sid, inv.permissionMode);
  }

  if (inv.team) {
    try {
      const team = agentDeckTeamRepo.ensureByName(inv.team, { source: 'cli' });
      try {
        agentDeckTeamRepo.addMember({
          teamId: team.id,
          sessionId: sid,
          role: 'lead',
          displayName: null,
        });
        eventBus.emit('agent-deck-team-member-changed', {
          teamId: team.id,
          sessionId: sid,
          kind: 'joined',
        });
      } catch (error) {
        if (!(error instanceof TeamInvariantError)) throw error;
      }
      await Promise.all(
        inv.members.map(async (member) => {
          const memberAdapter = adapterRegistry.get(member.adapter);
          if (!memberAdapter?.createSession) {
            logger.warn(
              `[cli] team member adapter "${member.adapter}" cannot create session; skip ${member.slug}`,
            );
            return;
          }
          try {
            const memberSid = await memberAdapter.createSession(
              buildCreateSessionOptions(member.adapter, {
                cwd,
                prompt: `你被 lead 加入了 team "${inv.team}"，等待 lead 通过 mcp__agent-deck__send_message 给你发消息。`,
                ...(inv.codexSandbox !== undefined && member.adapter === 'codex-cli'
                  ? { codexSandbox: inv.codexSandbox }
                  : {}),
                ...(inv.grokSandbox !== undefined && member.adapter === 'grok-build'
                  ? { grokSandbox: inv.grokSandbox }
                  : {}),
              }),
            );
            agentDeckTeamRepo.addMember({
              teamId: team.id,
              sessionId: memberSid,
              role: 'teammate',
              displayName: member.slug,
            });
            eventBus.emit('agent-deck-team-member-changed', {
              teamId: team.id,
              sessionId: memberSid,
              kind: 'joined',
            });
          } catch (error) {
            logger.warn(
              `[cli] failed to spawn team member ${member.slug}:${member.adapter}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      );
    } catch (error) {
      logger.warn(`[cli] team setup failed for "${inv.team}":`, error);
    }
  }

  if (inv.focus) {
    const win = getFloatingWindow().window;
    win?.show();
    win?.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
    eventBus.emit('session-focus-request', sid);
  }
}
