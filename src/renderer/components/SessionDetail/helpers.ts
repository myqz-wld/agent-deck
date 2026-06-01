/**
 * 把 file_changes 表里存的 before_blob / after_blob（TEXT 列）按 kind 解码成 DiffPayload 真正的 before/after。
 * - 'image'  → JSON.parse 出 ImageSource 对象
 * - 其他 kind（'text' / 'pdf' 等）→ 原样字符串返回（与历史行为兼容）
 *
 * 解析失败 / blob == null → 返回 null，由对应 renderer 自行处理空态。
 */
export function decodeBlob(kind: string, blob: string | null): unknown {
  if (blob == null) return null;
  if (kind === 'image') {
    try {
      return JSON.parse(blob);
    } catch {
      return null;
    }
  }
  return blob;
}

/** 文件改动 kind 枚举 → 中文显示标签（text → 文本 / image → 图片 / pdf/json 等保大写）。
 *  用在 ChangeTimeline badge 等用户可见处,避免 raw `TEXT` / `IMAGE` 给用户。 */
export function fileKindLabel(kind: string): string {
  switch (kind) {
    case 'text':
      return '文本';
    case 'image':
      return '图片';
    case 'pdf':
      return 'PDF';
    case 'json':
      return 'JSON';
    case 'binary':
      return '二进制';
    default:
      return kind.toUpperCase();
  }
}

/** 最小 file-change 形态（仅排序 / 分组用到的字段）；与 FileChangeRecord 结构兼容。 */
export interface FileChangeLike {
  id: number;
  filePath: string;
  ts: number;
}

export interface FileChangeGroup<T extends FileChangeLike> {
  filePath: string;
  /** 组内升序（旧 → 新），同毫秒按 id 升序兜底。 */
  items: T[];
  lastTs: number;
  lastId: number;
}

/**
 * 按 filePath 分组 file changes：组内升序（旧→新）+ 文件按最近改动倒序。
 *
 * deep-review H3 LOW（codex）：同毫秒同文件改动必须带 id tiebreaker（DB 端是 `ORDER BY ts DESC,
 * id DESC`，新 id 在前）。旧实现组内仅 `a.ts-b.ts` 稳定排序 + 取 `items[length-1]` 当最新 → 同 ts
 * 时顺序不定可能选到旧 row。这里组内 `(a.ts-b.ts)||(a.id-b.id)` 升序，组间 `lastTs||lastId` 倒序。
 */
export function groupFileChanges<T extends FileChangeLike>(changes: T[]): FileChangeGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const c of changes) {
    const arr = map.get(c.filePath) ?? [];
    arr.push(c);
    map.set(c.filePath, arr);
  }
  return [...map.entries()]
    .map(([filePath, items]) => {
      const sorted = items.sort((a, b) => a.ts - b.ts || a.id - b.id);
      const last = sorted[sorted.length - 1];
      return { filePath, items: sorted, lastTs: last.ts, lastId: last.id };
    })
    .sort((a, b) => b.lastTs - a.lastTs || b.lastId - a.lastId);
}

/**
 * 从扁平 file-change 列表选「真最新」一条（同毫秒按 id 更大者）。返回 null 当列表空。
 * deep-review H3 LOW：与 groupFileChanges 同 tiebreaker，diff tab 默认选中用。
 */
export function pickLatestChange<T extends FileChangeLike>(changes: T[]): T | null {
  if (changes.length === 0) return null;
  return [...changes].sort((a, b) => b.ts - a.ts || b.id - a.id)[0];
}
