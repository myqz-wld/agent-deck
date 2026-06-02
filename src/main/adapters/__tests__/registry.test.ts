/**
 * **REVIEW_105 MED-2 (deep-review Batch 7 双方共识) 回归**:
 *
 * registry.initAll per-adapter result —— 修前 initAll catch 后只 log 静默续跑 + 调用方
 * (bootstrap-infra) 不消费返回值, 半死 adapter 留在 registry 启动期零可观测。修法: initAll 返回
 * AdapterInitResult[] 让调用方明确 surface 失败, 同时保留「单 adapter 失败不连坐其他」resilience。
 *
 * 本测试用隔离 AdapterRegistryClass 实例(不污染 module-level singleton, 后者已被 bootstrap register)
 * + 最小 AgentAdapter stub 验证: ① 全成功 ② 部分失败仍续跑 + 失败项 ok:false 带 err ③ 失败 adapter
 * 仍留在 registry(get 仍返回, 印证 surface 的必要性)。
 */
import { describe, expect, it, vi } from 'vitest';

import { AdapterRegistryClass } from '../registry';
import type { AgentAdapter, AdapterContext } from '../types';

function makeStubAdapter(
  id: string,
  initBehavior: 'ok' | 'throw',
): AgentAdapter {
  return {
    id,
    displayName: id,
    capabilities: { canCreateSession: true } as AgentAdapter['capabilities'],
    init: vi.fn(async () => {
      if (initBehavior === 'throw') throw new Error(`${id} init boom`);
    }),
    shutdown: vi.fn(async () => {}),
  };
}

const FAKE_CTX = {} as AdapterContext;

describe('AdapterRegistryClass.initAll per-adapter result (REVIEW_105 MED-2)', () => {
  it('全 adapter init 成功 → 每项 ok:true 无 err', async () => {
    const reg = new AdapterRegistryClass();
    reg.register(makeStubAdapter('claude-code', 'ok'));
    reg.register(makeStubAdapter('codex-cli', 'ok'));

    const results = await reg.initAll(FAKE_CTX);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.every((r) => r.err === undefined)).toBe(true);
    expect(results.map((r) => r.id).sort()).toEqual(['claude-code', 'codex-cli']);
  });

  it('一个 adapter init 抛错 → 该项 ok:false 带 err, 另一个仍 ok:true (resilience 续跑不连坐)', async () => {
    const reg = new AdapterRegistryClass();
    const goodAdapter = makeStubAdapter('claude-code', 'ok');
    const badAdapter = makeStubAdapter('codex-cli', 'throw');
    reg.register(goodAdapter);
    reg.register(badAdapter);

    const results = await reg.initAll(FAKE_CTX);

    expect(results).toHaveLength(2);
    const good = results.find((r) => r.id === 'claude-code');
    const bad = results.find((r) => r.id === 'codex-cli');
    expect(good?.ok).toBe(true);
    expect(good?.err).toBeUndefined();
    expect(bad?.ok).toBe(false);
    expect(bad?.err).toBeInstanceOf(Error);
    expect((bad?.err as Error).message).toContain('codex-cli init boom');

    // 关键: 续跑不连坐 —— good adapter 的 init 确实被调用过(不因 bad 抛错而跳过)
    expect(goodAdapter.init).toHaveBeenCalledTimes(1);
  });

  it('init 失败的 adapter 仍留在 registry (get/list 仍返回它) —— 印证调用方必须 surface 否则 createSession 才晚爆', async () => {
    const reg = new AdapterRegistryClass();
    reg.register(makeStubAdapter('codex-cli', 'throw'));

    const results = await reg.initAll(FAKE_CTX);
    expect(results[0].ok).toBe(false);

    // 半死 adapter 仍可 get 到(这正是 MED-2 缺陷的根源: 不 surface 就静默暴露半死 adapter)
    expect(reg.get('codex-cli')).toBeDefined();
    expect(reg.list()).toHaveLength(1);
  });

  it('register 重复 id → throw (既有契约不回归)', () => {
    const reg = new AdapterRegistryClass();
    reg.register(makeStubAdapter('claude-code', 'ok'));
    expect(() => reg.register(makeStubAdapter('claude-code', 'ok'))).toThrow(
      /already registered/,
    );
  });
});
