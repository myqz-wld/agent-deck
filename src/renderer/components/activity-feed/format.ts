import type { AgentEvent } from '@shared/types';

/**
 * 稳定事件主键。原本用 `${e.ts}-${idx}` 在 store 头部插入新事件时让所有现存 row 的 idx +1，
 * 整个列表 remount，每行 useState mode（MD/TXT 切换、展开状态）全部丢失（REVIEW_2 修）。
 *
 * 优先级：
 * - tool-use-* 用 toolUseId（唯一稳定）
 * - waiting-for-user 用 type+requestId（同一请求 SDK 多次推送同 requestId 也只算一条）
 * - file-changed 用 ts+filePath（MultiEdit 拆出多条同 filePath 也按 ts 区分）
 * - 其余用 sessionId+kind+ts；同毫秒兜底加 payload 关键字段（若无则只能依赖时间戳，
 *   极小概率冲突也不会比原来 ts+idx 差）
 */
export function eventKey(e: AgentEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.kind === 'tool-use-start' || e.kind === 'tool-use-end') {
    const tid = typeof p.toolUseId === 'string' ? p.toolUseId : null;
    if (tid) return `${e.kind}:${tid}`;
  }
  if (e.kind === 'waiting-for-user') {
    const type = typeof p.type === 'string' ? p.type : '';
    const rid = typeof p.requestId === 'string' ? p.requestId : '';
    if (rid) return `wfu:${type}:${rid}`;
  }
  if (e.kind === 'file-changed') {
    const fp = typeof p.filePath === 'string' ? p.filePath : '';
    return `fc:${e.ts}:${fp}`;
  }
  return `${e.sessionId}:${e.kind}:${e.ts}`;
}

/** SDK 工具返回的 toolResult 可能是 string、{type,text}[]，或别的结构。 */
export function formatToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const block of result) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && b.text) parts.push(b.text);
        else parts.push(JSON.stringify(block));
      } else {
        parts.push(String(block));
      }
    }
    return parts.join('\n');
  }
  if (typeof result === 'object') return JSON.stringify(result, null, 2);
  return String(result);
}

/**
 * 解析 toolResult 是不是 mcp ImageRead 的结构化返回。
 * agent-deck-image-mcp 把 ImageToolResult JSON.stringify 后塞在 content[0].text 里。
 * 这里宽松解析（兼容 string content / Block[] content 两种形态），匹配 kind === 'image-read' 才返回。
 */
export function parseImageReadResult(content: unknown): {
  file: string;
  description: string;
  provider?: string;
  model?: string;
} | null {
  if (content == null) return null;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let parsed: unknown = null;
  if (typeof content === 'string') {
    parsed = tryParse(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object') {
        const bb = b as { type?: string; text?: string };
        if (bb.type === 'text' && typeof bb.text === 'string') {
          parsed = tryParse(bb.text);
          if (parsed) break;
        }
      }
    }
  }
  const v = parsed as
    | {
        kind?: string;
        file?: unknown;
        description?: unknown;
        provider?: unknown;
        model?: unknown;
      }
    | null;
  if (!v || v.kind !== 'image-read') return null;
  if (typeof v.file !== 'string' || typeof v.description !== 'string') return null;
  return {
    file: v.file,
    description: v.description,
    ...(typeof v.provider === 'string' ? { provider: v.provider } : {}),
    ...(typeof v.model === 'string' ? { model: v.model } : {}),
  };
}
