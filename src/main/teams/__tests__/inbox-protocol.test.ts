/**
 * inbox-protocol 单测：核心是 schema / slug 与 SDK CLI 二进制实证保持一致 + 锁竞争。
 *
 * 不需要真起 chokidar / 真启动子进程；纯文件 IO + JSON 校验。所有测试用 tmpdir。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  appendInboxMessage,
  buildPermissionResponse,
  getInboxPath,
  parseSubMessage,
  readInboxFile,
  slugifyMemberName,
  type InboxEntry,
} from '../inbox-protocol';

describe('slugifyMemberName', () => {
  it.each([
    ['team-lead', 'team-lead'],
    ['reviewer-claude', 'reviewer-claude'],
    ['reviewer/codex', 'reviewer-codex'],
    ['agent.deck', 'agent-deck'], // 注意 . 不在 [a-zA-Z0-9_-]，会被替成 -
    ['has space', 'has-space'],
    ['中文混杂abc', '----abc'],
    ['under_score', 'under_score'],
  ])('%s → %s（与 CLI eEH 函数同款 [^a-zA-Z0-9_-]→"-"）', (input, expected) => {
    expect(slugifyMemberName(input)).toBe(expected);
  });
});

describe('getInboxPath', () => {
  it('拼装 ~/.claude/teams/<teamSlug>/inboxes/<memberSlug>.json（与 CLI hMH 函数同款）', () => {
    const p = getInboxPath('dcr-tm-44', 'reviewer-codex');
    expect(p).toMatch(/\/\.claude\/teams\/dcr-tm-44\/inboxes\/reviewer-codex\.json$/);
  });
  it('特殊字符自动 slugify', () => {
    const p = getInboxPath('weird/name', 'a/b/c');
    expect(p).toMatch(/\/teams\/weird-name\/inboxes\/a-b-c\.json$/);
  });
});

describe('parseSubMessage', () => {
  it('识别 permission_request', () => {
    const text = JSON.stringify({
      type: 'permission_request',
      request_id: 'r1',
      agent_id: 'reviewer-codex',
      tool_name: 'Bash',
      input: { command: 'ls' },
    });
    const sub = parseSubMessage(text);
    expect(sub).not.toBeNull();
    expect(sub?.type).toBe('permission_request');
  });
  it('识别 permission_response success', () => {
    const text = JSON.stringify({
      type: 'permission_response',
      request_id: 'r1',
      subtype: 'success',
      response: {},
    });
    const sub = parseSubMessage(text);
    expect(sub?.type).toBe('permission_response');
  });
  it('识别 mode_set_request', () => {
    const text = JSON.stringify({
      type: 'mode_set_request',
      mode: 'bypassPermissions',
      from: 'team-lead',
    });
    const sub = parseSubMessage(text);
    expect(sub?.type).toBe('mode_set_request');
  });
  it('REVIEW_17 R1 / LOW-2：识别 idle_notification（CHANGELOG_48 加的 schema）', () => {
    const text = JSON.stringify({
      type: 'idle_notification',
      from: 'reviewer-codex',
      timestamp: '2026-04-30T19:08:29.578Z',
    });
    const sub = parseSubMessage(text);
    expect(sub?.type).toBe('idle_notification');
    if (sub?.type === 'idle_notification') {
      expect(sub.from).toBe('reviewer-codex');
    }
  });
  it('idle_notification 缺 from 字段返回 null（schema 防御）', () => {
    const text = JSON.stringify({ type: 'idle_notification', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(parseSubMessage(text)).toBeNull();
  });
  it('未知 type 返回 null', () => {
    const text = JSON.stringify({ type: 'random_thing' });
    expect(parseSubMessage(text)).toBeNull();
  });
  it('非 JSON 返回 null', () => {
    expect(parseSubMessage('not json')).toBeNull();
    expect(parseSubMessage('')).toBeNull();
  });
  it('permission_request 缺 request_id 返回 null（防御）', () => {
    const text = JSON.stringify({
      type: 'permission_request',
      tool_name: 'Bash',
      input: {},
    });
    expect(parseSubMessage(text)).toBeNull();
  });
});

describe('buildPermissionResponse', () => {
  it('allow → success + updated_input', () => {
    const sub = buildPermissionResponse('r1', 'allow', { updatedInput: { a: 1 } });
    expect(sub).toEqual({
      type: 'permission_response',
      request_id: 'r1',
      subtype: 'success',
      response: { updated_input: { a: 1 }, permission_updates: [] },
    });
  });
  it('allow without updatedInput → success + 空 updated_input', () => {
    const sub = buildPermissionResponse('r1', 'allow');
    expect(sub).toMatchObject({ subtype: 'success', response: { updated_input: {} } });
  });
  it('deny → error + reason', () => {
    const sub = buildPermissionResponse('r1', 'deny', { reason: '不行' });
    expect(sub).toEqual({
      type: 'permission_response',
      request_id: 'r1',
      subtype: 'error',
      error: '不行',
    });
  });
  it('deny without reason → 默认中文文案', () => {
    const sub = buildPermissionResponse('r1', 'deny');
    expect(sub).toMatchObject({ subtype: 'error', error: '用户已拒绝' });
  });
});

describe('readInboxFile / appendInboxMessage（带 tmpdir 重定向 HOME）', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tmpHome = await mkdtemp(join(tmpdir(), 'inbox-protocol-test-'));
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('readInboxFile 文件不存在 → []', async () => {
    const p = getInboxPath('test-team', 'team-lead');
    const arr = await readInboxFile(p);
    expect(arr).toEqual([]);
  });

  it('appendInboxMessage 自动建目录 + 文件 + 写入一条 permission_response', async () => {
    const sub = buildPermissionResponse('rXXX', 'allow', { updatedInput: { foo: 'bar' } });
    await appendInboxMessage('test-team', 'reviewer-codex', sub);

    const p = getInboxPath('test-team', 'reviewer-codex');
    expect(existsSync(p)).toBe(true);
    const arr = await readInboxFile(p);
    expect(arr).toHaveLength(1);
    const e = arr[0];
    expect(e.from).toBe('team-lead');
    expect(e.read).toBe(false);
    expect(typeof e.timestamp).toBe('string');
    const parsed = parseSubMessage(e.text);
    expect(parsed).toEqual(sub);
  });

  it('appendInboxMessage 多条追加保持原序（lock 串行）', async () => {
    await appendInboxMessage(
      'test-team',
      'reviewer-codex',
      buildPermissionResponse('r1', 'allow'),
    );
    await appendInboxMessage(
      'test-team',
      'reviewer-codex',
      buildPermissionResponse('r2', 'deny', { reason: 'no' }),
    );
    const p = getInboxPath('test-team', 'reviewer-codex');
    const arr = await readInboxFile(p);
    expect(arr).toHaveLength(2);
    expect(parseSubMessage(arr[0].text)?.type).toBe('permission_response');
    const r1 = parseSubMessage(arr[0].text) as { request_id: string };
    const r2 = parseSubMessage(arr[1].text) as { request_id: string };
    expect(r1.request_id).toBe('r1');
    expect(r2.request_id).toBe('r2');
  });

  it('readInboxFile 容错坏 JSON（返回空 + warn）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = getInboxPath('test-team', 'reviewer-codex');
    // 直接写损坏 JSON
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, '{not json', 'utf8');

    const arr = await readInboxFile(p);
    expect(arr).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('readInboxFile 顶层不是数组 → []（容错 schema 演进）', async () => {
    const p = getInboxPath('test-team', 'reviewer-codex');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, '{"not": "array"}', 'utf8');
    const arr = await readInboxFile(p);
    expect(arr).toEqual([]);
  });

  it('readInboxFile 过滤掉缺字段的元素（schema 防御）', async () => {
    const p = getInboxPath('test-team', 'reviewer-codex');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(p), { recursive: true });
    const data: unknown[] = [
      { from: 'a', text: 'b', timestamp: '2026-01-01T00:00:00.000Z', read: true } satisfies InboxEntry,
      { from: 'a', text: 'no timestamp', read: true }, // 缺 timestamp，要被过滤
      'not an object',
      { from: 'a', timestamp: 'x' }, // 缺 text
    ];
    await writeFile(p, JSON.stringify(data), 'utf8');
    const arr = await readInboxFile(p);
    expect(arr).toHaveLength(1);
    expect(arr[0].text).toBe('b');
  });

  it('原子写：appendInboxMessage 写完原文件不留 .tmp 残骸', async () => {
    await appendInboxMessage(
      'test-team',
      'reviewer-codex',
      buildPermissionResponse('r1', 'allow'),
    );
    const { readdir } = await import('node:fs/promises');
    const dir = join(tmpHome, '.claude', 'teams', 'test-team', 'inboxes');
    const files = await readdir(dir);
    expect(files).toContain('reviewer-codex.json');
    expect(files.find((f) => f.includes('.tmp'))).toBeUndefined();
  });

  it('文件已存在但内容损坏：append 仍能基于空数组继续追加（保数据可用）', async () => {
    const p = getInboxPath('test-team', 'reviewer-codex');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, '{not json', 'utf8');

    // 容错：append 不抛错（readInboxFile 退化空数组），写入完只剩这一条
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appendInboxMessage(
      'test-team',
      'reviewer-codex',
      buildPermissionResponse('rNew', 'allow'),
    );
    const recovered = await readFile(p, 'utf8');
    expect(JSON.parse(recovered)).toHaveLength(1);
    warn.mockRestore();
  });

  it('appendInboxMessage 透传 fromAgentId / color', async () => {
    await appendInboxMessage(
      'test-team',
      'reviewer-codex',
      buildPermissionResponse('r1', 'allow'),
      { fromAgentId: 'custom-from', color: 'red' },
    );
    const p = getInboxPath('test-team', 'reviewer-codex');
    const arr = await readInboxFile(p);
    expect(arr[0].from).toBe('custom-from');
    expect(arr[0].color).toBe('red');
  });
});
