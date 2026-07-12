/**
 * 端到端 logger hook test (plan log-noise-and-disposed-20260603 R3 补):
 *
 * reviewer-claude R2 关键 MED: 单测纯函数 + mock 是「测假象」(R1 no-op 二次重演),
 * 必须用真 logger 端到端验 — emit log.error → 验 file transport 写盘行为。
 * vitest-setup.ts:21 注释明示「NOT mock: electron-log/node」(spike runner 入口,
 * 纯 Node 不依赖 electron),本测通过 `import 'electron-log/node'` 拿真包实例,
 * 设 file transport 路径到 tmp,emit 后读 file 验:双关键词不落盘 + 普通行落盘。
 *
 * 抓回归(详 reviewer-claude R2 铁证):
 * - HIGH-1: 早期 fix 装 transports.file.hooks 错对象, electron-log 不读 → 0 过滤。
 *   本测: emit 双关键词 → 断言 file 不写。早期 fix 此 case 会 fail (file 写入了)。
 * - HIGH-2: keep-path 返 undefined → reduce 短路 → 整条丢。早期 fix 此 case 业务日志
 *   全没了。本测: emit 普通 log → 断言 file 写了。
 *
 * 跑环境: vitest 默认 NODE_ENV=test + node 环境, electron-log/node 真包可用
 * (不依赖 electron app object — NodeExternalApi 走 process.stderr/output)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import realLog from 'electron-log/node';
import {
  shouldDropClaudeCanUseToolShadowedNoise,
  shouldDropWebFrameMainDisposedNoise,
} from '../logger';

// electron-log/node 是真包(不依赖 electron),hook 装到 log.hooks 模拟生产链
// (Logger.js:177 `this.hooks.reduce(...)`)。FilterLogMessage 与 LogMessage 结构子集
// 兼容,这里用同样的 hook wrapper 形式装,跟生产代码走的是同一条 reduce 路径。
const webFrameMainDisposedNoiseHook = (
  message: { data: unknown[] },
  _transport: unknown,
  transportName?: string,
): { data: unknown[] } | false => {
  if (transportName !== 'file') return message;
  return shouldDropWebFrameMainDisposedNoise(message) ||
    shouldDropClaudeCanUseToolShadowedNoise(message)
    ? false
    : message;
};

describe('logger hook 端到端 (electron-log/node 真包 + tmp file transport)', () => {
  let tmpLogFile: string;
  const webFrameMainDisposedNoiseHookRef = webFrameMainDisposedNoiseHook;

  beforeEach(() => {
    tmpLogFile = path.join(
      os.tmpdir(),
      `agent-deck-logger-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );
    // swap file transport 路径到 tmp + 关 console noise
    realLog.transports.file.resolvePathFn = () => tmpLogFile;
    realLog.transports.console.level = false; // 测试期间关掉 console 噪声
    realLog.transports.file.level = 'silly'; // 让所有 level 都进 file transport
    // 装 hook 到 Logger 实例级 log.hooks (与生产 logger.ts 装的位置一致)
    const hooks = realLog.hooks as unknown as ((m: { data: unknown[] }, t: unknown, n?: string) => { data: unknown[] } | false)[];
    if (!hooks.includes(webFrameMainDisposedNoiseHookRef)) {
      hooks.push(webFrameMainDisposedNoiseHookRef);
    }
  });

  afterEach(() => {
    // 还原: 卸 hook + 还原 file transport level / resolvePathFn / console
    const hooks = realLog.hooks as unknown as ((m: { data: unknown[] }, t: unknown, n?: string) => { data: unknown[] } | false)[];
    const idx = hooks.indexOf(webFrameMainDisposedNoiseHookRef);
    if (idx >= 0) hooks.splice(idx, 1);
    realLog.transports.file.level = 'info';
    // 清掉 resolvePathFn 重置回 electron-log/node default(os.tmpdir() path)
    delete (realLog.transports.file as { resolvePathFn?: unknown }).resolvePathFn;
    realLog.transports.console.level = 'silly';
    if (fs.existsSync(tmpLogFile)) fs.unlinkSync(tmpLogFile);
  });

  it('双关键词同时命中 data[0] → file transport 不落盘 (HIGH-1 关键回归)', () => {
    realLog.error('Error sending from webFrameMain:  Error: Render frame was disposed before WebFrameMain could be accessed');
    // electron-log file transport 默认 async 写,等 microtask flush
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      const content = fs.existsSync(tmpLogFile) ? fs.readFileSync(tmpLogFile, 'utf8') : '';
      expect(content).not.toContain('Render frame was disposed');
    });
  });

  it('Electron 真实 split args: prefix string + Error object → file transport 不落盘', () => {
    realLog.error(
      'Error sending from webFrameMain: ',
      new Error('Render frame was disposed before WebFrameMain could be accessed'),
    );
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      const content = fs.existsSync(tmpLogFile) ? fs.readFileSync(tmpLogFile, 'utf8') : '';
      expect(content).not.toContain('Render frame was disposed');
    });
  });

  it('普通业务 log → file transport 落盘 (HIGH-2 关键回归: 验证 keep-path 返 message 不丢业务日志)', () => {
    realLog.info('plain business log message');
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      const content = fs.existsSync(tmpLogFile) ? fs.readFileSync(tmpLogFile, 'utf8') : '';
      expect(content).toContain('plain business log message');
    });
  });

  it('Claude bypass canUseTool 固定 SDK warning → file transport 不占 error channel', () => {
    realLog.error(
      "(node:123) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked: permissionMode 'bypassPermissions'",
    );
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      const content = fs.existsSync(tmpLogFile) ? fs.readFileSync(tmpLogFile, 'utf8') : '';
      expect(content).not.toContain('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED');
    });
  });

  it('双关键词混合普通 log(同一 call data 多 arg 错配形态) → file transport 落盘', () => {
    // 防御: ensure 'Render frame was disposed' substring alone doesn't trigger drop
    realLog.info('plain', 'Render frame was disposed in some other context', 'normal tail');
    return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
      const content = fs.existsSync(tmpLogFile) ? fs.readFileSync(tmpLogFile, 'utf8') : '';
      expect(content).toContain('Render frame was disposed in some other context');
    });
  });
});
