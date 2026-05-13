/**
 * sessions.ts handOffSpawn helper 单测（REVIEW_33 H6）
 *
 * 关键验证：buildHandOffCreateSessionOpts 必须把原 session 的 codexSandbox /
 * claudeCodeSandbox 透传到新 session createSession opts，避免用户切沙盒后
 * hand-off 起的新 session 落 settings 全局默认（隐性沙盒 downgrade）。
 *
 * 纯函数测试，import sessions-hand-off-helper 而非 sessions.ts，避免拉起 Electron
 * import 链（sessions.ts 通过 sessionManager / sessionRepo / eventBus 间接 import
 * Electron / SQLite）。
 */
import { describe, expect, it } from 'vitest';
import { buildHandOffCreateSessionOpts } from '../sessions-hand-off-helper';
import type { SessionRecord } from '@shared/types';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sid-1',
    agentId: 'claude-code',
    cwd: '/Users/test/project',
    title: 'fake',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 0,
    lastEventAt: 0,
    endedAt: null,
    archivedAt: null,
    spawnedBy: null,
    spawnDepth: 0,
    ...overrides,
  } as SessionRecord;
}

describe('buildHandOffCreateSessionOpts — REVIEW_33 H6 sandbox 透传', () => {
  it('原 session 无 permissionMode / sandbox → opts 只含 cwd + prompt（不写空字段，让 adapter 走 fallback）', () => {
    const session = makeSession();
    const opts = buildHandOffCreateSessionOpts(session, 'continue from prev');
    expect(opts).toEqual({
      cwd: '/Users/test/project',
      prompt: 'continue from prev',
    });
    // 关键：不应有 permissionMode / codexSandbox / claudeCodeSandbox 字段
    expect('permissionMode' in opts).toBe(false);
    expect('codexSandbox' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('原 session permissionMode=acceptEdits → opts 透传', () => {
    const session = makeSession({ permissionMode: 'acceptEdits' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    expect(opts.permissionMode).toBe('acceptEdits');
  });

  it('REVIEW_33 H6 核心：codexSandbox=read-only → 必须透传（修前漏 → 隐性沙盒 downgrade 到 workspace-write 全局默认）', () => {
    const session = makeSession({ agentId: 'codex-cli', codexSandbox: 'read-only' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    expect(opts.codexSandbox).toBe('read-only');
  });

  it('REVIEW_33 H6 核心：claudeCodeSandbox=strict → 必须透传（修前漏 → 隐性沙盒 downgrade 到 off 全局默认）', () => {
    const session = makeSession({ claudeCodeSandbox: 'strict' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    expect(opts.claudeCodeSandbox).toBe('strict');
  });

  it('全字段都设：四个透传字段 + cwd + prompt 全在 opts 内', () => {
    const session = makeSession({
      permissionMode: 'plan',
      codexSandbox: 'workspace-write',
      claudeCodeSandbox: 'workspace-write',
    });
    const opts = buildHandOffCreateSessionOpts(session, 'continue work');
    expect(opts).toEqual({
      cwd: '/Users/test/project',
      prompt: 'continue work',
      permissionMode: 'plan',
      codexSandbox: 'workspace-write',
      claudeCodeSandbox: 'workspace-write',
    });
  });

  it('null 字段（DB 列允许 null）→ 不写 opts（走 fallback）', () => {
    const session = makeSession({
      permissionMode: undefined,
      codexSandbox: null,
      claudeCodeSandbox: null,
    });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    expect('permissionMode' in opts).toBe(false);
    expect('codexSandbox' in opts).toBe(false);
    expect('claudeCodeSandbox' in opts).toBe(false);
  });

  it('permissionMode=default 也透传（与原 session 行为完全对齐，不挑挑拣拣）', () => {
    // 注：原 handler line 119 的 recordCreatedPermissionMode 才会跳过 'default'，
    // 但 opts 透传仍按 truthy 规则把 'default' 字符串透传过去（adapter 收到 'default'
    // 就当 default 处理 — 与 settings.permissionMode 全局值合并由 adapter 决定）。
    const session = makeSession({ permissionMode: 'default' });
    const opts = buildHandOffCreateSessionOpts(session, 'p');
    expect(opts.permissionMode).toBe('default');
  });
});
