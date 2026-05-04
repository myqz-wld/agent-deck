/**
 * Agent Teams in-process backend permission inbox 监听器（CHANGELOG_45）。
 *
 * **背景**：teammate 调 Bash 等需审批工具时，CLI 不会回到 lead 的 SDK canUseTool 回调
 * （那个绑在 lead Query 实例上）。CLI 改为把 `permission_request` JSON 文本塞进 lead 的 inbox
 * 文件 `~/.claude/teams/<team>/inboxes/team-lead.json`，等 lead 写 `permission_response` 回
 * teammate inbox。lead Claude 自己看不懂这种结构化消息，应用必须代为识别 + 让用户审批。
 *
 * 模式：与 [team-watcher.ts](./team-watcher.ts) 同款引用计数 + chokidar + 60s grace。但监听
 * 对象不同（`inboxes/*.json` 整个目录），且发现 `permission_request` 后会 emit 应用事件
 * `'team-permission-requested'` 让 main bootstrap 桥接到 IPC 推 renderer。
 *
 * **关键去重**：chokidar 每次 file change 都重读全文件。本模块维护 per-team 进程内
 * `Set<requestId>` 表「已 emit / 已响应过的」，避免重复触发，避免响应后又被 inbox 文件下次
 * change 重新弹给用户。
 *
 * **进程退出**：调用 `inboxWatcher.shutdownAll()` 立即 close 所有 watcher（不等 grace）。
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { TeamPermissionCancelled, TeamPermissionRequest } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { settingsStore } from '@main/store/settings-store';
import {
  appendInboxMessage,
  buildPermissionResponse,
  getInboxesRoot,
  parseSubMessage,
  readInboxFile,
  slugifyMemberName,
  type IdleNotificationSubMessage,
  type InboxEntry,
  type PermissionRequestSubMessage,
} from './inbox-protocol';
import { lookupLeadPermissionMode, shouldAutoApprove } from './auto-approve';

const GRACE_MS = 60_000;
const AWAIT_WRITE_FINISH = { stabilityThreshold: 250, pollInterval: 100 } as const;

interface Entry {
  watcher: FSWatcher;
  refCount: number;
  graceTimer: NodeJS.Timeout | null;
  /** 已 emit / 已响应过的 request_id（去重）。 */
  seenRequestIds: Set<string>;
  /**
   * 当前还在 pending 的 permission_request 元数据，按 fromAgentId 索引（同 teammate 可能
   * 同时有多个 pending），用于 idle_notification 检测时批量 emit cancel。
   * key = request_id，value = 完整 request payload（用于 emit cancel 时重建上下文）。
   *
   * 何时清理：
   * - inbox-watcher 检测到该 teammate 写 idle_notification → 批量 emit cancel + 删
   * - main bridge 监听 team-permission-resolved（用户在 UI 批/拒）后写 permission_response
   *   到 teammate inbox 时也清掉——但应用层不直接 hook resolved，靠下次 inbox process
   *   时该 request_id 已 in seenRequestIds + 不在新一轮 inbox 里就行（idempotent）
   */
  activePermissions: Map<string, { fromAgentId: string; payload: TeamPermissionRequest }>;
}

class InboxWatcherManager {
  private entries = new Map<string, Entry>();

  size(): number {
    return this.entries.size;
  }

  /**
   * 引用计数 +1。第一次订阅时建 chokidar watcher 监听 inbox 目录。
   * grace 期内重新订阅则取消 grace timer。
   */
  subscribe(name: string): void {
    let entry = this.entries.get(name);
    if (entry) {
      entry.refCount += 1;
      if (entry.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
      return;
    }
    const inboxesDirRaw = join(getInboxesRoot(), slugifyMemberName(name), 'inboxes');
    // realpath 化 inboxesDir：如果 ~/.claude 是 symlink（典型 dotfile 场景），chokidar 在
    // macOS fsevents 下回 handler 的 filepath 是 realpath 化路径，与 raw symlink path 严格
    // 字符串比较永远不等 → handle 永远 early return → emit 永远不 fire（实测踩过）。
    // 这里 subscribe 时一次性 realpath 化 + cache expectedLeadInbox，让 chokidar 路径与
    // 比较基线统一在 realpath 命名空间。
    if (!existsSync(inboxesDirRaw)) {
      // inbox 目录可能首次 subscribe 时还不存在（teammate 还没写）；先建以便 realpath 成功
      mkdirSync(inboxesDirRaw, { recursive: true });
    }
    const inboxesDir = realpathSync(inboxesDirRaw);
    const expectedLeadInbox = join(inboxesDir, 'team-lead.json');
    // chokidar 监听整个 inboxes 目录（不限 lead，未来如果应用需要替别的成员代收 permission
    // 也能用同样模式扩展）。当前实现只看 team-lead.json，文件名校验在事件 handler 内做。
    const watcher = chokidar.watch(inboxesDir, {
      persistent: true,
      ignoreInitial: false, // 启动时也读一遍现有内容（捕获应用启动前 teammate 已经写入的请求）
      awaitWriteFinish: AWAIT_WRITE_FINISH,
    });
    const entryRef: Entry = {
      watcher,
      refCount: 1,
      graceTimer: null,
      seenRequestIds: new Set(),
      activePermissions: new Map(),
    };
    this.entries.set(name, entryRef);

    // REVIEW_17 R2 / H2-R2 修复：subscribe 时一次性 prewarm seenRequestIds —— 扫所有 teammate
    // inbox 找出已写入 permission_response 的 request_id，把它们加进 seenRequestIds，让随后
    // chokidar ignoreInitial:false replay lead inbox 时跳过 emit「已响应过的旧 permission_request」。
    // 不阻塞 subscribe 同步返回（fire-and-forget），prewarm 完成前 chokidar 可能已 fire add，
    // 那段时间内 process 用空 seenRequestIds 把旧 request 重 emit 一遍 —— 罕见，是降级体验
    // 不是 bug；prewarm 完成后第二次 file change 会被正确 dedup。
    void this.prewarmSeenFromTeammateResponses(inboxesDir, entryRef);

    const handle = (filepath: string): void => {
      // 只关心 team-lead.json（lead inbox）。其他成员的 inbox 应用不代为审批。
      // 未来要扩展（e.g. lead 替 teammate 审批 sub-teammate 请求）就在这里加判断。
      if (filepath !== expectedLeadInbox) return;
      void this.processInboxFile(name, filepath, entryRef);
    };
    watcher.on('add', handle);
    watcher.on('change', handle);
    // unlink: inbox 文件被删（用户 rm / cleanup）→ 清掉去重集（下次重建可以重新 emit）
    watcher.on('unlink', (filepath: string) => {
      if (filepath === expectedLeadInbox) {
        entryRef.seenRequestIds.clear();
        entryRef.activePermissions.clear();
      }
    });
    watcher.on('error', (err) => {
      console.warn(`[inbox-watcher] error for "${name}":`, err);
    });
    console.log(`[inbox-watcher] subscribe "${name}" (size=${this.entries.size})`);
  }

  /**
   * REVIEW_17 R2 / H2-R2：subscribe 入口的「已响应预热」。扫 teammate inboxes 目录所有
   * `*.json`（每个 teammate 一个文件，含 lead 写给它的 permission_response）—— 把所有
   * `permission_response.request_id` 加进 entry.seenRequestIds，让 chokidar
   * `ignoreInitial:false` replay lead inbox 时跳过 emit「已被响应过的 permission_request」。
   *
   * 触发场景：用户上次 approve/deny 一条 permission_request → 应用写 permission_response
   * 到 teammate inbox（appendInboxMessage） → markResponded(requestId) 加进 in-memory
   * seenRequestIds → 应用退出，seenRequestIds 全丢 → 重启 → chokidar replay lead inbox
   * 把那条已响应的 permission_request 又 emit 一遍 → 用户在 PendingTab 看到旧 request。
   *
   * 不抛错（任何 IO 失败都吞 console.warn）。fire-and-forget：subscribe 不 await 它，
   * 让 chokidar.watch 立即开始监听；prewarm 完成前若已 fire add，那段窗口内可能仍重 emit
   * 一份 stale request —— 罕见、降级体验、非 bug。prewarm 完成后第二次 change 即正常 dedup。
   */
  private async prewarmSeenFromTeammateResponses(
    inboxesDir: string,
    entryRef: Entry,
  ): Promise<void> {
    let files: string[];
    try {
      files = await readdir(inboxesDir);
    } catch (err) {
      console.warn(`[inbox-watcher] prewarm readdir failed @ ${inboxesDir}:`, err);
      return;
    }
    let count = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      // team-lead.json 自己是发 permission_request 的源（不是 response 容器），跳过
      if (f === 'team-lead.json') continue;
      let entries: InboxEntry[];
      try {
        entries = await readInboxFile(join(inboxesDir, f));
      } catch (err) {
        console.warn(`[inbox-watcher] prewarm readInboxFile failed @ ${f}:`, err);
        continue;
      }
      for (const e of entries) {
        const sub = parseSubMessage(e.text);
        if (!sub || sub.type !== 'permission_response') continue;
        if (typeof sub.request_id === 'string' && sub.request_id.length > 0) {
          if (!entryRef.seenRequestIds.has(sub.request_id)) {
            entryRef.seenRequestIds.add(sub.request_id);
            count += 1;
          }
        }
      }
    }
    if (count > 0) {
      console.log(`[inbox-watcher] prewarm seen ${count} already-responded request_id(s) @ ${inboxesDir}`);
    }
  }

  /**
   * 引用计数 -1。到 0 后启动 60s grace 计时器；触发时再次确认 refCount===0 才真 close。
   */
  unsubscribe(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.graceTimer = setTimeout(() => {
      const cur = this.entries.get(name);
      if (!cur || cur.refCount > 0) return;
      void cur.watcher.close().catch((err) => {
        console.warn(`[inbox-watcher] close failed for "${name}":`, err);
      });
      this.entries.delete(name);
      console.log(`[inbox-watcher] grace-close "${name}" (size=${this.entries.size})`);
    }, GRACE_MS);
  }

  /**
   * 标记 request_id 已被响应（用户在 UI 点 approve/deny 后调）。把 id 加进 seenRequestIds，
   * 避免下次 inbox 文件 change（如 lead 端读消息修改 read 标记）又把这条重新 emit 出来；
   * 同时从 activePermissions 删，避免 idle_notification 触发 cancel 时把已响应的也算上。
   */
  markResponded(name: string, requestId: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.seenRequestIds.add(requestId);
    entry.activePermissions.delete(requestId);
  }

  /**
   * REVIEW_17 R1 / H2：返回**已 emit / 已响应**过的去重集合（含 idle:* 去重键）。
   * 名字诚实写作 listSeenRequestIds —— 不要改名 listPending，那是另一个语义
   * （走 activePermissions.keys() 见下面 listPendingRequestIds）。
   *
   * 仅供调试：HMR / renderer 重启后用来观察 inbox-watcher 已识别过的所有 id
   * （含 `idle:<from>:<timestamp>` 字符串作 idle 去重键，**不是 requestId 列表**）。
   * 想拿真 pending 列表（renderer 重建 UI 用）必须走 listPendingRequestIds。
   */
  listSeenRequestIds(name: string): string[] {
    const entry = this.entries.get(name);
    if (!entry) return [];
    return Array.from(entry.seenRequestIds);
  }

  /**
   * REVIEW_17 R1 / H2：返回**真正 pending**的 permission_request id 列表
   * （activePermissions Map keys，对应 processInboxFile 第 226 行 set 后、markResponded
   * 第 156 行 / idle_notification cancel 第 259 行 delete 之间的 in-memory 状态）。
   *
   * 与 listSeenRequestIds 区别：
   * - listSeenRequestIds = 已见过 / 已响应的去重集合（含 idle:* 字符串），仅供调试
   * - listPendingRequestIds = 当前未响应 / 未被 idle 取消的 request id（renderer 重建 UI 用）
   *
   * IPC TeamListPendingPermissions 走这个；preload 暴露时也走这个。
   */
  listPendingRequestIds(name: string): string[] {
    const entry = this.entries.get(name);
    if (!entry) return [];
    return Array.from(entry.activePermissions.keys());
  }

  async shutdownAll(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [, entry] of this.entries) {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      closes.push(entry.watcher.close());
    }
    this.entries.clear();
    await Promise.allSettled(closes);
  }

  /**
   * 读 inbox 文件 → 找未见过的 permission_request → emit 应用事件；同时检测
   * idle_notification 触发已 active permission 的 cancel emit（teammate idle ≈ 它不再
   * 处理任何 pending tool call → pending permission 可视为 cancel）。
   * 不抛错（任何 IO / parse 失败都吞到 console.warn）。
   */
  private async processInboxFile(
    teamName: string,
    filepath: string,
    entryRef: Entry,
  ): Promise<void> {
    if (!existsSync(filepath)) return;
    let entries: InboxEntry[];
    try {
      entries = await readInboxFile(filepath);
    } catch (err) {
      console.warn(`[inbox-watcher] readInboxFile failed @ ${filepath}:`, err);
      return;
    }

    // REVIEW_17 R3 / M2-R3：原来分两遍 for-of 各跑 N 次 parseSubMessage（permission_request
    // 一遍 + idle_notification 一遍），inbox 长跑后 N 几百到几千 entries 时尾延迟 ~10ms+。
    // 合并为单遍 + switch on sub.type，一半 parseSubMessage 调用。
    //
    // 顺序保留：先识别本轮新出现的 permission_request → emit + 记入 activePermissions；
    // 同一轮内的 idle_notification 紧随其后处理（按数组顺序自然先 emit request 再 emit cancel）。
    // 业务正确性不受影响：activePermissions Map 在同一遍循环内即时更新，idle_notification
    // 检测到本批次 add 进的 fromAgentId 也会正确 cancel。
    //
    // emit 包 try/catch + 失败回滚（REVIEW_17 R2 / MED-R2-1），避免 listener 抛错污染 dedup。
    for (const e of entries) {
      const sub = parseSubMessage(e.text);
      if (!sub) continue;

      if (sub.type === 'permission_request') {
        const req = sub as PermissionRequestSubMessage;
        if (entryRef.seenRequestIds.has(req.request_id)) continue;
        // 同步 add 在前是 dedup 的真正护栏，防 await lookupLeadPermissionMode /
        // appendInboxMessage 期间另一波 file change 重入又走一次 try（reviewer-codex MED）
        entryRef.seenRequestIds.add(req.request_id);

        const fromAgentId = req.agent_id ?? e.from;
        const payload: TeamPermissionRequest = {
          type: 'team-permission-request',
          requestId: req.request_id,
          teamName,
          fromAgentId,
          fromMemberSlug: slugifyMemberName(fromAgentId),
          toolName: req.tool_name,
          toolInput: (req.input ?? {}) as Record<string, unknown>,
          description: req.description,
          permissionSuggestions: req.permission_suggestions,
          inboxFilePath: filepath,
          timestamp: e.timestamp,
        };

        // CHANGELOG_<X> B4：auto-approve 决策。命中 read-only 白名单 / follow-lead 档放行
        // 条件 → 应用层主动写 inbox response allow + emit resolved，跳过 UI 弹框。
        // reviewer 双对抗修复：嵌套 try/catch 区分 append 失败（→ 回滚 dedup + emit
        // requested 走 UI 兜底）与 emit 失败（response 已写 inbox，dedup 必须保留）。
        const mode = settingsStore.get('autoApproveTeammateMode');
        const leadMode = await lookupLeadPermissionMode(teamName);
        const decision = shouldAutoApprove(req.tool_name, mode, leadMode);

        if (decision.approve) {
          console.log(
            `[inbox-watcher] auto-approve ${req.tool_name} for ${fromAgentId} ` +
              `(${decision.reason}, leadMode=${leadMode ?? 'null'})`,
          );
          let appendOk = false;
          try {
            // fromAgentId='team-lead' 是 inbox 协议常量，与 IPC TeamRespondPermission handler
            // (ipc/teams.ts:142) 同款。CLI 端默认接受此 from（CHANGELOG_45 实测）。
            const respSub = buildPermissionResponse(req.request_id, 'allow', {
              updatedInput: req.input,
            });
            await appendInboxMessage(teamName, slugifyMemberName(fromAgentId), respSub, {
              fromAgentId: 'team-lead',
            });
            appendOk = true;
          } catch (appendErr) {
            // append 失败 → response 没写到 inbox，回滚 dedup（让下次 lead inbox change
            // 重读 entries 时这条仍能再 try）+ 走 UI 兜底（避免「auto-approve 静默失败 +
            // lead inbox 不再变化」死锁——chokidar 不会因 teammate inbox 写失败而 fire
            // processInboxFile，必须主动 emit requested 让用户在 PendingTab 看见）。
            console.warn(
              `[inbox-watcher] auto-approve append failed for ${req.request_id}, falling back to UI:`,
              appendErr,
            );
            entryRef.seenRequestIds.delete(req.request_id);
            entryRef.activePermissions.set(req.request_id, { fromAgentId, payload });
            try {
              eventBus.emit('team-permission-requested', payload);
            } catch (emitErr) {
              // 兜底失败也只能 warn，回滚 active（与下面手动路径同款）
              console.warn(
                `[inbox-watcher] fallback emit team-permission-requested also failed:`,
                emitErr,
              );
              entryRef.activePermissions.delete(req.request_id);
            }
            continue;
          }

          // append 成功 → inbox 文件已写，dedup 必须保留（绝不能 delete）。
          // emit team-permission-resolved 抛错只 warn，不回滚——否则下次 lead inbox change
          // 重读 entries 会让该 entry 再走一遍 try → 重复 append 双 response。
          // 不写 activePermissions Map（该 Map 用于 idle_notification cancel pending；既然已
          // resolved 没什么可 cancel；与 markResponded 语义等价）。
          if (appendOk) {
            try {
              eventBus.emit('team-permission-resolved', {
                teamName,
                requestId: req.request_id,
              });
            } catch (emitErr) {
              console.warn(
                `[inbox-watcher] emit team-permission-resolved failed (response already written, dedup kept):`,
                emitErr,
              );
            }
            continue;
          }
        }

        // 未命中 auto-approve → 走原 emit team-permission-requested 路径（手动审批）
        entryRef.activePermissions.set(req.request_id, { fromAgentId, payload });
        try {
          eventBus.emit('team-permission-requested', payload);
        } catch (err) {
          console.warn(
            `[inbox-watcher] emit team-permission-requested failed for ${req.request_id}, rolling back seen+active:`,
            err,
          );
          // 回滚：让下次 file change 有机会重 emit 这条 request
          entryRef.seenRequestIds.delete(req.request_id);
          entryRef.activePermissions.delete(req.request_id);
        }
      } else if (sub.type === 'idle_notification') {
        // teammate 主动通报「我闲了 / 不再处理 pending tool call」，
        // 此时它之前提的 permission_request 不会再被它响应（即便 lead 写 permission_response
        // 回 inbox，teammate 已 abort 不读了），UI 上标 cancelled 让用户知道这条不需要再批。
        // dedup key 用 idle:<from>:<timestamp> 防同条 idle 反复触发。
        const idle = sub as IdleNotificationSubMessage;
        const idleKey = `idle:${idle.from}:${e.timestamp}`;
        if (entryRef.seenRequestIds.has(idleKey)) continue;
        entryRef.seenRequestIds.add(idleKey);

        // 找该 teammate 名下所有 active permission，emit cancel
        const cancelled: string[] = [];
        const removedFromActive: Array<[string, { fromAgentId: string; payload: TeamPermissionRequest }]> = [];
        try {
          for (const [reqId, info] of entryRef.activePermissions) {
            if (info.fromAgentId !== idle.from) continue;
            cancelled.push(reqId);
            const cancelPayload: TeamPermissionCancelled = {
              type: 'team-permission-cancelled',
              requestId: reqId,
              teamName,
              fromAgentId: info.fromAgentId,
              reason: 'teammate-idle',
            };
            eventBus.emit('team-permission-cancelled', cancelPayload);
            removedFromActive.push([reqId, info]);
          }
          for (const [reqId] of removedFromActive) entryRef.activePermissions.delete(reqId);
        } catch (err) {
          // 回滚：idleKey 删掉让下次 change 重试；未删的 activePermissions 保留
          console.warn(
            `[inbox-watcher] emit team-permission-cancelled failed for idle "${idle.from}":`,
            err,
          );
          entryRef.seenRequestIds.delete(idleKey);
        }
        if (cancelled.length > 0) {
          console.log(
            `[inbox-watcher] teammate idle "${idle.from}" → cancelled ${cancelled.length} pending permission(s)`,
          );
        }
      }
    }
  }
}

export const inboxWatcher = new InboxWatcherManager();
