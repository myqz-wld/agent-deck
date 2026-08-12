import { describe, expect, it } from 'vitest';

import type { SessionRecord, StoredAgentEvent } from '@shared/types';
import { projectSessionEvents, projectSessionText } from './session-event-projection';

const session: SessionRecord = {
  id: 'session-a',
  agentId: 'codex-cli',
  cwd: '/workspaces/repo',
  title: 'Session',
  source: 'sdk',
  lifecycle: 'active',
  activity: 'idle',
  startedAt: 1,
  lastEventAt: 2,
  endedAt: null,
  archivedAt: null,
};

function event(payload: unknown): StoredAgentEvent {
  return {
    id: 7,
    sessionId: session.id,
    agentId: '',
    kind: 'message',
    payload,
    ts: 3,
  };
}

describe('Server Core event projection', () => {
  it('projects Workspace paths and removes attachments, binary values, and private roots', () => {
    const result = projectSessionEvents([event({
      cwd: '/workspaces/repo',
      file_path: '/workspaces/repo/src/index.ts',
      outsidePath: '/etc/shadow',
      secret: 'cache=/state/provider-cache/token',
      apiToken: 'sk-secretmarker123',
      credentialLocationHint: '/opt/worker-private/credential.json',
      note: 'Bearer abcdefghijklmnop at /srv/worker/private',
      attachments: [{ path: '/workspaces/repo/image.png' }],
      dataUrl: 'data:image/png;base64,AAAA',
    })], session, 20, {
      workspaceRoot: '/workspaces',
      privateRoots: ['/state'],
    });
    expect(result.events[0]).toMatchObject({
      agentId: 'codex-cli',
      payload: {
        cwd: 'Workspace/repo',
        file_path: 'Workspace/repo/src/index.ts',
        outsidePath: '[outside Workspace]',
        secret: '[敏感内容已省略]',
        apiToken: '[敏感内容已省略]',
        credentialLocationHint: '[敏感内容已省略]',
        note: 'Bearer [敏感内容已省略] at [outside Workspace]',
        attachments: [],
        dataUrl: '[远程视图已省略二进制内容]',
      },
    });
  });

  it('sets the truncation bit when more rows exist than the requested page', () => {
    const result = projectSessionEvents([event({ text: 'first' }), {
      ...event({ text: 'second' }), id: 8,
    }], session, 1, { workspaceRoot: '/workspaces', privateRoots: [] });
    expect(result.events).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('preserves the unified-diff null device while redacting external headers', () => {
    expect(projectSessionText([
      '--- /dev/null',
      '+++ /workspaces/repo/src/added.ts',
      '--- /workspaces/repo/src/deleted.ts',
      '+++ /dev/null',
      '--- /etc/core-secret',
      '+++ /dev/null',
    ].join('\n'), {
      workspaceRoot: '/workspaces',
      privateRoots: ['/state'],
    })).toBe([
      '--- /dev/null',
      '+++ Workspace/repo/src/added.ts',
      '--- Workspace/repo/src/deleted.ts',
      '+++ /dev/null',
      '--- [outside Workspace]',
      '+++ /dev/null',
    ].join('\n'));
  });

  it('projects extended headers without rewriting header-shaped hunk content', () => {
    expect(projectSessionText([
      'diff --git a/src/relative-old.ts b/src/relative-new.ts',
      'diff --git "a/src/relative old.ts" "b/src/relative new.ts"',
      'diff --git "/etc/old name.conf" "/opt/worker/new name.conf"',
      String.raw`diff --git "/etc/old\" name.ts" "/opt/new\" name.ts"`,
      'diff --git /etc/old.conf /opt/worker/new.conf',
      'diff --git a//etc/prefixed-old.conf b//opt/worker/prefixed-new.conf',
      'rename from /etc/old.conf',
      String.raw`rename from "/etc/old\\name.ts"`,
      'rename to /workspaces/repo/new.conf',
      'copy from /state/provider-cache/template.conf',
      String.raw`copy from "/state/provider\040cache/template.conf"`,
      'copy to /workspaces/repo/copy.conf',
      'Binary files /etc/old.bin and /opt/worker/new.bin differ',
      '--- a//etc/prefixed-old.conf',
      '+++ b//opt/worker/prefixed-new.conf',
      '--- /workspaces/repo/old.conf',
      '+++ /workspaces/repo/new.conf',
      '@@ -1,2 +1,2 @@',
      ' context',
      '--- [outside Workspace]',
      '+++ [outside Workspace]',
      '--- /etc/next-header',
      '+++ /opt/next-header',
    ].join('\n'), {
      workspaceRoot: '/workspaces',
      privateRoots: ['/state'],
    })).toBe([
      'diff --git a/src/relative-old.ts b/src/relative-new.ts',
      'diff --git "a/src/relative old.ts" "b/src/relative new.ts"',
      'diff --git "[outside Workspace]" "[outside Workspace]"',
      'diff --git "[outside Workspace]" "[outside Workspace]"',
      'diff --git [outside Workspace] [outside Workspace]',
      'diff --git a/[outside Workspace] b/[outside Workspace]',
      'rename from [outside Workspace]',
      'rename from "[outside Workspace]"',
      'rename to Workspace/repo/new.conf',
      'copy from [private]',
      'copy from "[private]"',
      'copy to Workspace/repo/copy.conf',
      'Binary files [outside Workspace] and [outside Workspace] differ',
      '--- a/[outside Workspace]',
      '+++ b/[outside Workspace]',
      '--- Workspace/repo/old.conf',
      '+++ Workspace/repo/new.conf',
      '@@ -1,2 +1,2 @@',
      ' context',
      '--- [outside Workspace]',
      '+++ [outside Workspace]',
      '--- [outside Workspace]',
      '+++ [outside Workspace]',
    ].join('\n'));
  });
});
