/**
 * RecoveryCancelledError — recover / restart 期间「用户主动 close（或 scheduler 衰减 / delete）」
 * 的 cancellation sentinel（REVIEW_99 R3 carry-forward cancellation-epoch 方案）。
 *
 * **动机**（REVIEW_99 R3 reviewer-codex HIGH + MED carry-forward）:
 * closed 会话被用户合法 resume → recover 入口 emit user message(source:'sdk') 经 ensure
 * closed→active 复活 → `await injectResumeHistory`(LLM 10-30s)/ createSession 内部
 * loadSdk·buildMcpServers pre-registration await 期间用户**再次** close → 旧 isCancelledFn
 * 用 `closed && !wasClosed` lifecycle 快照判定漏掉「恢复期间第二次 close」(wasClosed=true
 * 让条件恒 false)→ createSession 反转用户显式 close 起一个不想要的 fresh CLI(按次计费)。
 *
 * **修法 = cancellation epoch**:closeImpl / markClosedImpl / deleteImpl 对每 session 自增
 * close-epoch 计数器(SessionManager.getCloseEpoch);recover 入口 emit user message **之后**
 * 捕获 `closeEpochBaseline`,多检查点比对 `getCloseEpoch(sid) !== baseline || record missing`
 * → 直接信号「close 动作发生过没有」而非「当前 lifecycle 是不是 closed」的快照推断。
 *
 * **本 sentinel 的角色**:createSession 内部 pre-registration await 之后、真正 query / startThread
 * 之前的 MED 检查点若发现 cancel → throw 本 sentinel。recoverer / helper 必须 special-case
 * 识别(isRecoveryCancelledError)后**静默 abort**(不进 outer catch emit「自动恢复失败」错误文案)。
 * recover 路径单飞 IIFE 把所有 abort 路径(jsonl-fallback aborted + MED pre-registration guard)统一
 * **throw 本 sentinel → p reject**(而非 resolve 一个 union object):① 让等待者 catch 内 special-case
 * 跳过 sendThunk retry(codex 第 4 点)② first-caller outer catch special-case 静默 return sessionId。
 * **为何 throw 而非 union return**:`recovering` Map 与 restart-controller 共享,restart producer 存
 * `Promise<string>`;若 recoverer 改返 union object,一个 recoverer waiter 等到 restart 的 string 读
 * `.kind` 会 undefined 误判。sentinel-throw 让两 producer Promise 都保持 `Promise<string>`,靠鸭子
 * 类型 isRecoveryCancelledError 在 reject 路径识别 → 交叉 await 类型安全。
 *
 * **property-based guard**:用 `__recoveryCancelled` 属性标记 + isRecoveryCancelledError 鸭子类型
 * 判定(而非纯 instanceof),避免跨 module realm / test mock 边界 instanceof 失效。
 */
export class RecoveryCancelledError extends Error {
  /** 鸭子类型标记 — isRecoveryCancelledError 据此识别,跨 realm / mock 边界稳健。 */
  readonly __recoveryCancelled = true as const;

  constructor(public readonly sessionId: string) {
    super(
      `recovery cancelled for ${sessionId} (session closed during createSession pre-registration window)`,
    );
    this.name = 'RecoveryCancelledError';
  }
}

/**
 * 鸭子类型判定 err 是否 RecoveryCancelledError(检 `__recoveryCancelled === true` 属性,
 * 不走 instanceof)。recoverer / helper outer catch 用本 guard 区分「cancellation sentinel
 * (静默 abort)」vs「真 createSession 失败(emit 自动恢复失败 + wasClosed markClosed 回滚)」。
 */
export function isRecoveryCancelledError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { __recoveryCancelled?: unknown }).__recoveryCancelled === true
  );
}
