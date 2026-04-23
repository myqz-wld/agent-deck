import type {
  ActivityState,
  AgentEvent,
  LifecycleState,
  SessionRecord,
  SessionSource,
} from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** 路径标准化：消化 `.`/`..`、尾斜杠、符号链接，让两端 cwd 比较稳定。 */
function normalizeCwd(cwd: string): string {
  if (!cwd) return '';
  try {
    return realpathSync(resolvePath(cwd));
  } catch {
    return resolvePath(cwd).replace(/\/+$/, '');
  }
}
import { fileChangeRepo } from '@main/store/file-change-repo';

interface UpsertOptions {
  agentId: string;
  cwd?: string;
  title?: string;
  source?: SessionSource;
}

/**
 * SessionManager 是 AgentEvent 的中央汇集点。所有 adapter 都通过 ingest()
 * 把事件灌入这里，由它统一更新数据库 + 推动状态机 + 广播给渲染端。
 *
 * activity 状态机由本类直接维护；lifecycle 由 LifecycleScheduler 负责（M5）。
 *
 * 去重：Claude Code 的会话可能同时被 SDK 通道（query AsyncGenerator）和
 * Hook 通道（settings.json 注入的 hook）观测到。SDK 通道粒度更细，因此
 * 一旦 ClaudeSdkBridge 调用 claimAsSdk(sessionId)，后续来自 hook 的
 * 同 id 事件会被丢弃。
 */
class SessionManagerClass {
  /** 由 SDK 通道接管的会话 id，hook 同 id 事件会被丢弃 */
  private sdkOwned = new Set<string>();

  /**
   * SDK 启动 CLI 子进程后到拿到真实 session_id 之前，hook 通道可能先一步上报。
   * 这段时间用 cwd 做"待领取"标记：hook 首次出现该 cwd 的新 session 时，
   * 把它主动 claim 为 SDK，并丢弃那条 hook 事件，避免出现「内/外」两份重复会话。
   */
  private pendingSdkCwds = new Map<string, number>(); // cwd → 失效时间戳

  claimAsSdk(sessionId: string): void {
    this.sdkOwned.add(sessionId);
  }

  releaseSdkClaim(sessionId: string): void {
    this.sdkOwned.delete(sessionId);
  }

  /** SDK 即将拉起 cwd 上的会话；ttl 内任何 hook 通道首发的新 session 自动归 SDK 所有。
   *  cwd 经过 realpath + normalize，避免符号链接 / 尾斜杠差异导致漏匹配。 */
  expectSdkSession(cwd: string, ttlMs = 60_000): () => void {
    const key = normalizeCwd(cwd);
    const expiresAt = Date.now() + ttlMs;
    this.pendingSdkCwds.set(key, expiresAt);
    console.log(`[session-mgr] expect sdk session @ ${key} (ttl ${ttlMs}ms)`);
    return () => {
      if (this.pendingSdkCwds.get(key) === expiresAt) {
        this.pendingSdkCwds.delete(key);
      }
    };
  }

  private consumePendingSdkClaim(cwd: string): boolean {
    const key = normalizeCwd(cwd);
    const expiresAt = this.pendingSdkCwds.get(key);
    if (expiresAt && Date.now() <= expiresAt) {
      this.pendingSdkCwds.delete(key);
      return true;
    }
    // 兜底：精确未命中但池子里只有一个 pending（必然就是它）→ 模糊匹配。
    // 覆盖 cwd 表示在某些极端情况仍有差异（如 macOS /private/var ↔ /var）的场景。
    if (this.pendingSdkCwds.size === 1) {
      const [onlyKey, onlyExp] = [...this.pendingSdkCwds.entries()][0];
      if (Date.now() <= onlyExp) {
        console.log(`[session-mgr] sdk-claim fuzzy-match: hook=${key} ↔ pending=${onlyKey}`);
        this.pendingSdkCwds.delete(onlyKey);
        return true;
      }
    }
    if (expiresAt) this.pendingSdkCwds.delete(key);
    return false;
  }

  /** 注册新会话或更新已有会话 */
  ensure(sessionId: string, opts: UpsertOptions): SessionRecord {
    const existing = sessionRepo.get(sessionId);
    if (existing) {
      // 收到新事件 → 复活：closed 推回 active。
      // 注意：归档（archivedAt）与 lifecycle 正交，是用户的主动隐藏意图，
      // 不能因为后续事件流就自动 unarchive，否则用户刚归档的 active 会话
      // 下一秒收到 hook 事件就被默默放回实时面板，违背 CLAUDE.md「正交」约定。
      // 取消归档必须由 unarchive() 显式调用。
      if (existing.lifecycle === 'closed') {
        const revived: SessionRecord = {
          ...existing,
          lifecycle: 'active',
          endedAt: null,
        };
        sessionRepo.upsert(revived);
        eventBus.emit('session-upserted', revived);
        return revived;
      }
      return existing;
    }
    const now = Date.now();
    const rec: SessionRecord = {
      id: sessionId,
      agentId: opts.agentId,
      cwd: opts.cwd ?? '',
      title: opts.title ?? deriveTitle(opts.cwd ?? sessionId),
      source: opts.source ?? 'cli',
      lifecycle: 'active',
      activity: 'idle',
      startedAt: now,
      lastEventAt: now,
      endedAt: null,
      archivedAt: null,
    };
    sessionRepo.upsert(rec);
    eventBus.emit('session-upserted', rec);
    return rec;
  }

  /** 入口：adapter 发来的所有 AgentEvent 都走这里 */
  ingest(event: AgentEvent): void {
    // 去重：SDK 已接管的会话，丢弃 hook 通道事件（避免重复入库）
    if (event.source === 'hook' && this.sdkOwned.has(event.sessionId)) {
      return;
    }

    // 时序竞争兜底：SDK 已注册要拉起这个 cwd 的会话，但真实 session_id 还没到，
    // hook 通道（CLI 子进程内部 hook）先一步上报。这时如果是该 cwd 上首次见到的
    // 新 sessionId，认作 SDK 派生：claim 它的 id，丢弃这条 hook 事件，等 SDK 通道事件来。
    if (event.source === 'hook' && !sessionRepo.get(event.sessionId)) {
      const cwd = extractCwd(event);
      if (cwd && this.consumePendingSdkClaim(cwd)) {
        console.log(
          `[session-mgr] hook→sdk re-claim: sessionId=${event.sessionId} cwd=${cwd}`,
        );
        this.claimAsSdk(event.sessionId);
        return;
      }
    }

    const record = this.ensure(event.sessionId, {
      agentId: event.agentId,
      cwd: extractCwd(event),
      // SDK 通道发来的事件 → 应用内会话；hook 通道（含未标 source 的） → 外部 CLI 会话
      source: event.source === 'sdk' ? 'sdk' : 'cli',
    });

    // 1. 落库 events
    eventRepo.insert(event);

    // 2. 若是 file-changed，落库 file_changes
    if (event.kind === 'file-changed') {
      const p = event.payload as {
        filePath?: string;
        kind?: string;
        before?: unknown;
        after?: unknown;
        toolCallId?: string;
        metadata?: Record<string, unknown>;
      };
      if (p && typeof p.filePath === 'string') {
        // text 通道 before/after 是 string，原样存；image 通道是 ImageSource 对象，需 JSON.stringify。
        // file_changes.before_blob / after_blob 列是 TEXT，序列化后存得下（典型 < 200 chars）。
        const serialize = (v: unknown): string | null => {
          if (v == null) return null;
          if (typeof v === 'string') return v;
          return JSON.stringify(v);
        };
        fileChangeRepo.insert({
          sessionId: event.sessionId,
          filePath: p.filePath,
          kind: p.kind ?? 'text',
          beforeBlob: serialize(p.before),
          afterBlob: serialize(p.after),
          metadata: p.metadata ?? {},
          toolCallId: p.toolCallId ?? null,
          ts: event.ts,
        });
      }
    }

    // 3. 推进 activity 状态机 + lifecycle 复活
    const nextActivity = nextActivityState(record.activity, event.kind, event.payload);
    let nextLifecycle: LifecycleState = record.lifecycle;
    if (record.lifecycle !== 'active') {
      // 任意事件都让会话回到 active（复活）
      nextLifecycle = 'active';
    }
    if (event.kind === 'session-end') {
      // Hook 通道的 session-end = 终端里 CLI 真退出了，没法再续 → closed。
      // SDK 通道的 session-end = 我们这边 query 流终止（用户中断 / dev 重启 / 流出错），
      // 但 ~/.claude/projects 里的对话历史还在，用户随时可以 resume → 标 dormant 更合理。
      nextLifecycle = event.source === 'sdk' ? 'dormant' : 'closed';
    }

    // 「会话状态真的变了」走重 upsert + 广播 session-upserted（renderer store 同步整个 record）。
    // 「只是 lastEventAt 推进」走轻量 setActivity 单列 UPDATE，不再广播 —— renderer 通过
    // agent-event 事件已经知道有新动作；session-upserted 高频会话场景下会被联动放大成
    // IPC 风暴（每条事件一次 latestSummaries 重读 SQL，10 个活跃会话 = 50 IPC/s 全是浪费）。
    //
    // 不在判定里写 archivedAt：归档与 lifecycle 正交，归档的会话来事件不应自动 unarchive。
    if (nextActivity !== record.activity || nextLifecycle !== record.lifecycle) {
      const updated: SessionRecord = {
        ...record,
        activity: nextActivity,
        lifecycle: nextLifecycle,
        lastEventAt: event.ts,
        endedAt: nextLifecycle === 'closed' ? event.ts : null,
      };
      sessionRepo.upsert(updated);
      eventBus.emit('session-upserted', updated);
    } else {
      // 仅刷新 activity（即便没真变也顺便把 last_event_at 推进）。
      // 不广播 session-upserted —— renderer 不需要为「只是 lastEventAt 变了」重渲染整张卡。
      sessionRepo.setActivity(event.sessionId, nextActivity, event.ts);
    }

    // 4. 广播原始事件给渲染端
    eventBus.emit('agent-event', event);
  }

  /** lifecycle scheduler 用：把 active 推到 dormant */
  markDormant(sessionId: string): void {
    const r = sessionRepo.get(sessionId);
    if (!r || r.lifecycle !== 'active') return;
    sessionRepo.setLifecycle(sessionId, 'dormant', Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  /** lifecycle scheduler 用：把 dormant 推到 closed */
  markClosed(sessionId: string): void {
    const r = sessionRepo.get(sessionId);
    if (!r || (r.lifecycle !== 'dormant' && r.lifecycle !== 'active')) return;
    sessionRepo.setLifecycle(sessionId, 'closed', Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  archive(sessionId: string): void {
    // 只设归档标记，不动 lifecycle —— 这样取消归档可以恢复原本的生命周期。
    sessionRepo.setArchived(sessionId, Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  unarchive(sessionId: string): void {
    // 取消归档：清掉 archived_at，lifecycle 保留不变，
    // 会话自动按真实 lifecycle 出现在对应面板（active/dormant→实时，closed→历史）。
    sessionRepo.setArchived(sessionId, null);
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  reactivate(sessionId: string): void {
    const r = sessionRepo.get(sessionId);
    if (!r) return;
    sessionRepo.setLifecycle(sessionId, 'active', Date.now());
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  /**
   * 创建会话后把用户选过的 permissionMode 持久化到 sessions 列。
   * IPC 路径（renderer 新建对话框）和 CLI 路径（agent-deck new --permission-mode ...）
   * 都要调用，否则两条入口语义会飘：UI 显示 default 但 SDK 实际是 plan，
   * 或者反过来，跟实际状态对不上。'default' 等价于不设（不污染 CLI 通道列），
   * 其他值（acceptEdits / plan / bypassPermissions）才写入。
   */
  recordCreatedPermissionMode(sessionId: string, mode: string | undefined): void {
    if (!mode || mode === 'default') return;
    sessionRepo.setPermissionMode(
      sessionId,
      mode as Parameters<typeof sessionRepo.setPermissionMode>[1],
    );
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  delete(sessionId: string): void {
    sessionRepo.delete(sessionId);
    eventBus.emit('session-removed', sessionId);
  }

  /**
   * 把 fromId 的 sessions 行 + 子表引用整体迁到 toId（保留所有事件 / 文件改动 / 总结），
   * 然后通知 renderer 同步迁移 selectedId / by-session 状态。
   * 用于 SDK fallback 路径：tempKey 占位 → 真实 session_id 出现后无损切换，
   * 用户保持在 detail，不被踢回主界面。
   */
  renameSdkSession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    sessionRepo.rename(fromId, toId);
    eventBus.emit('session-renamed', { from: fromId, to: toId });
    const updated = sessionRepo.get(toId);
    if (updated) eventBus.emit('session-upserted', updated);
  }

  list(): SessionRecord[] {
    return sessionRepo.listActiveAndDormant();
  }

  get(id: string): SessionRecord | null {
    return sessionRepo.get(id);
  }
}

/**
 * activity 状态机推进。
 *
 * 注意 `waiting-for-user` 这个 kind 在两条通路上语义并不统一：
 * - SDK 通道 emit 的 `permission-cancelled` / `ask-question-cancelled` /
 *   `exit-plan-cancelled` 也用这个 kind，但它本质是「请把那条 pending 撤掉」
 *   而不是「又一次需要用户输入」。如果按 kind 一律切到 'waiting'，会出现
 *   「按完按钮后状态卡在 waiting + 弹一条多余的等待提醒」。
 * - 因此这里需要看 payload.type：以 `-cancelled` 结尾的视为「取消」事件，
 *   activity 不动（保持 current）。
 */
function nextActivityState(
  current: ActivityState,
  kind: AgentEvent['kind'],
  payload: unknown,
): ActivityState {
  switch (kind) {
    case 'session-start':
      return 'idle';
    case 'tool-use-start':
    case 'message':
    case 'thinking':
    case 'file-changed':
      return 'working';
    case 'tool-use-end':
      return current === 'waiting' ? 'waiting' : 'working';
    case 'waiting-for-user': {
      const type = (payload as { type?: string } | null | undefined)?.type;
      if (typeof type === 'string' && type.endsWith('-cancelled')) {
        // SDK 自己撤掉的 pending：不切状态，保留之前的 activity。
        // 真实的 pending Map 是否清空由 store / pendingMap 自己维护。
        return current;
      }
      return 'waiting';
    }
    case 'finished':
      return 'finished';
    case 'session-end':
      return current;
    default:
      return current;
  }
}

function extractCwd(event: AgentEvent): string | undefined {
  const p = event.payload as { cwd?: string } | null | undefined;
  return p?.cwd;
}

function deriveTitle(cwd: string): string {
  if (!cwd) return '未命名会话';
  const segs = cwd.replace(/\/$/, '').split('/');
  return segs[segs.length - 1] || cwd;
}

export const sessionManager = new SessionManagerClass();
