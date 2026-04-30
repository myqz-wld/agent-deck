/**
 * 跨进程共享：文件改动 / Diff payload / Image 工具结果类型。
 */

export interface FileChangeRecord {
  id: number;
  sessionId: string;
  filePath: string;
  kind: string; // 'text' | 'image' | 'pdf' | ...
  beforeBlob: string | null;
  afterBlob: string | null;
  metadata: Record<string, unknown>;
  toolCallId: string | null;
  ts: number;
}

export interface DiffPayload<T = unknown> {
  kind: string;
  filePath: string;
  before: T | null;
  after: T | null;
  metadata?: Record<string, unknown>;
  toolCallId?: string;
  ts: number;
}

// ───────────────────────────────────────────────────────── Image Tools (MCP)

/**
 * 图片在事件流 / DiffPayload 里的承载形态。**不存图片二进制本身**，只存「怎么读到它」。
 * - kind:'path' 直接用绝对路径，主进程读盘后转 dataURL 给 renderer
 * - kind:'snapshot' 二期预留：让 MCP server 把快照交给 agent-deck 自管目录后用 id 索引
 * 之所以加这层抽象：MCP server 维护着自己的快照目录（ImageEdit 的 beforeFile 就放在那里），
 * 这些路径之后可能被 server 清理，DiffPayload 里只存「读取契约」让 renderer 兜底失效场景。
 */
export type ImageSource =
  | { kind: 'path'; path: string }
  | { kind: 'snapshot'; snapshotId: string };

/**
 * 本地 MCP server 暴露的图片工具的 tool_result 形态约定。
 * MCP server 在 `tool_result.content` 中放一个 `{type:'text', text: JSON.stringify(<下面这个>)}`，
 * agent-deck 解析后翻译成 file-changed 事件 + DiffPayload<ImageSource>（image-write/edit/multi-edit），
 * 或直接在活动流卡片里展示（image-read 不进 file-changed，UI 显示缩略图 + LLM 描述）。
 *
 * 工具语义（与 agent-deck-image-mcp 仓库一致）：
 * - ImageRead       = vision LLM 理解一张图，返回文字描述（不写盘）
 * - ImageWrite      = 文生图（prompt → 新图）写入 file_path
 * - ImageEdit       = 图生图（原图 + prompt → 新图）覆盖 file_path
 * - ImageMultiEdit  = 同一张图串行多次图生图（与文本 MultiEdit 对称）
 *
 * 路径要求：所有 file / beforeFile / afterFile 必须是**绝对路径**。
 * - file 是用户视角的真实文件路径（== input.file_path），工具完成后磁盘上的内容 == afterFile
 * - beforeFile / afterFile 是 server 自管快照目录里的副本（agent-deck 不复制不清理）
 *
 * ImageMultiEdit 语义（与文本 MultiEdit 完全对称）：
 * - 所有 edits 串行作用在「同一张图」（input 的 file_path）上
 * - 第 i 条 edit 的 beforeFile = 上一条的 afterFile（i=0 时 = 原图快照）
 * - agent-deck 把 N 条 edit 拆成 N 条独立的 file-changed 事件（filePath 都用 result.file），
 *   metadata 带 editIndex / total / prompt / provider / model，让 SessionDetail 时间线天然展示「演进步骤」
 */
export type ImageToolResult =
  | {
      kind: 'image-read';
      file: string;
      /** vision LLM 对这张图的描述（agent-deck 在活动流缩略图旁展示） */
      description: string;
      /** vision provider 名（'gemini' / 'openai' / ...），用于 UI 标注与调试 */
      provider?: string;
      model?: string;
      mime?: string;
      width?: number;
      height?: number;
    }
  | {
      kind: 'image-write';
      file: string;
      prompt: string;
      provider?: string;
      model?: string;
      mime?: string;
    }
  | {
      kind: 'image-edit';
      file: string;
      beforeFile: string;
      afterFile: string;
      prompt: string;
      provider?: string;
      model?: string;
      mime?: string;
    }
  | {
      kind: 'image-multi-edit';
      file: string;
      provider?: string;
      model?: string;
      edits: Array<{
        beforeFile: string;
        afterFile: string;
        prompt: string;
      }>;
    };

/**
 * window.api.loadImageBlob 的返回结构。
 * 失败不抛错，由 UI 显示「图片不可读」灰底（覆盖 server 清理快照后的兼容场景）。
 */
export type LoadImageBlobResult =
  | { ok: true; dataUrl: string; mime: string; bytes: number }
  | {
      ok: false;
      reason: 'enoent' | 'too_big' | 'denied' | 'invalid_ext' | 'io_error' | 'unsupported_source';
      detail?: string;
    };
