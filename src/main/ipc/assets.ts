/**
 * Assets Library IPC handlers（CHANGELOG_57 C2 / plan codex-handoff-team-alignment-20260518
 * §P3 Step 3.4 双 adapter cascade / plan assets-codex-user-and-ui-unify-20260521 §D3 §D5 §D7
 * 双 adapter user 自定义补齐 + UI sub-tab 统一改造）。
 *
 * Channels in this module cover bundled/user asset reads, user CRUD, bundled Agent runtime
 * deltas, Codex provider suggestions, and Finder reveal:
 *   - AssetsListBundled / AssetsListUser    —— 列表
 *   - AssetsGetContent                      —— 单个 asset 完整 md（含 frontmatter）
 *   - AssetsSaveUser / AssetsDeleteUser     —— 用户自定义 CRUD
 *   - AssetsRevealInFolder                  —— shell.showItemInFolder 跨平台显示
 *
 * 入参校验：name 走 isSafeName（slug `[a-z0-9-]+`，长度 1-64），kind 严格枚举，
 * source 严格枚举，UserAssetInput 委托 user-assets.saveUserAsset 内部校验。
 * 所有失败统一返回 `{ ok: false, reason }`，renderer 透传给用户。
 *
 * **plan assets-codex-user-and-ui-unify-20260521 §D7 升级**：
 * - `AssetMeta.adapter` user 资产也带 ('claude-code' | 'codex-cli')，null 删除
 * - `AssetsGetContent` / `AssetsRevealInFolder` / `AssetsDeleteUser` source==='user' 时也必传 adapter
 *   （user 资产现也按 adapter 派发到不同 root：~/.claude/{agents,skills}/ vs ~/.codex/{agents,skills}/）
 * - `AssetsSaveUser` UserAssetInput 加 adapter 字段（必填）
 * - `validateAdapterKind` 保留为 adapter/kind 兼容性收口点；当前 Claude/Codex agent/skill 组合都支持
 */
import { shell } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type {
  AssetAdapter,
  AssetKind,
  AssetSource,
  UserAssetAdapter,
  UserAssetInput,
} from '@shared/types';
import { ASSET_LIMITS, validateAdapterKind } from '@shared/types';
import { on, IpcInputError, parseStringId } from './_helpers';
import {
  getBundledAssets,
  getBundledAssetContent,
  getBundledAssetPath,
  isSafeName,
} from '@main/bundled-assets';
import {
  deleteUserAsset,
  getUserAssetContent,
  getUserAssetPath,
  listUserAssets,
  saveUserAsset,
} from '@main/user-assets';
import {
  resetBundledAgentRuntimeOverride,
  saveBundledAgentRuntimeOverride,
} from '@main/bundled-agent-runtime-overrides';
import { listCodexModelProviders } from '@main/codex-config/model-providers';

const KIND_VALUES: ReadonlyArray<AssetKind> = ['agent', 'skill'];
const SOURCE_VALUES: ReadonlyArray<AssetSource> = ['bundled', 'user'];
const ADAPTER_VALUES: ReadonlyArray<AssetAdapter> = [
  'claude-code',
  'codex-cli',
  'grok-build',
];
const USER_ADAPTER_VALUES: ReadonlyArray<UserAssetAdapter> = [
  'claude-code',
  'codex-cli',
];

function parseKind(value: unknown): AssetKind {
  if (typeof value !== 'string' || !KIND_VALUES.includes(value as AssetKind)) {
    throw new IpcInputError('kind', `must be one of ${KIND_VALUES.join('|')}, got ${String(value)}`);
  }
  return value as AssetKind;
}

function parseSource(value: unknown): AssetSource {
  if (typeof value !== 'string' || !SOURCE_VALUES.includes(value as AssetSource)) {
    throw new IpcInputError('source', `must be one of ${SOURCE_VALUES.join('|')}, got ${String(value)}`);
  }
  return value as AssetSource;
}

/**
 * adapter 必传校验（plan §D7 升级）：bundled 与 user 都必传 adapter narrow key。
 *
 * - bundled：narrow 到具体 plugin root（claude-config / codex-config）取 SSOT
 * - user：narrow 到 ~/.claude/ 或 ~/.codex/ 对应 root（user 资产现也按 adapter 派发）
 *
 * 与旧版 `parseBundledAdapterOrNull`（user 路径忽略 adapter）的 breaking change：
 * 老 caller 传 null 时 throw IpcInputError 而非静默接受。
 */
function parseAdapterRequired(value: unknown): AssetAdapter {
  if (typeof value !== 'string' || !ADAPTER_VALUES.includes(value as AssetAdapter)) {
    throw new IpcInputError(
      'adapter',
      `must be one of ${ADAPTER_VALUES.join('|')}, got ${String(value)}`,
    );
  }
  return value as AssetAdapter;
}

function parseUserAdapterRequired(value: unknown): UserAssetAdapter {
  if (
    typeof value !== 'string' ||
    !USER_ADAPTER_VALUES.includes(value as UserAssetAdapter)
  ) {
    throw new IpcInputError(
      'adapter',
      `must be one of ${USER_ADAPTER_VALUES.join('|')} for user assets, got ${String(value)}`,
    );
  }
  return value as UserAssetAdapter;
}

function parseAssetName(value: unknown): string {
  const name = parseStringId('name', value, ASSET_LIMITS.name);
  if (!isSafeName(name)) {
    throw new IpcInputError(
      'name',
      `must match ASSET_NAME_REGEX (^[a-z0-9][a-z0-9-]*$), length 1-${ASSET_LIMITS.name} (got "${name}")`,
    );
  }
  return name;
}

/**
 * 校验 frontmatter 单行字段（description / tools / model）：
 * - 长度上限 见 `ASSET_LIMITS.<field>`（CHANGELOG_57 R1·F4 收口防 100MB body 卡 main）
 * - **禁含换行 `\n`**（CHANGELOG_57 R1·F2：手写 stringifyFrontmatter 单行 join，多行 value
 *   写盘后被 parseFrontmatter `(.*)$` 单行 regex 静默截断，下次回读 description 只剩首行）
 * - **禁含 `---`**（CHANGELOG_57 R1·F3：description: "x\n---\nname: hijacked" 串成嵌套
 *   frontmatter 块；同时禁单串 `---` 即可拦死所有变种，包括 `\n---\n`、`---\n`、`\r\n---`）
 *
 * 触发即拒（throw IpcInputError），renderer 透传给用户错误信息让其修正。
 *
 * 不限字符集（中文 / emoji 都允许），仅限结构性危险字符。
 */
function parseSingleLineString(field: string, value: unknown, maxLen: number): string {
  if (typeof value !== 'string') {
    throw new IpcInputError(field, `must be string, got ${typeof value}`);
  }
  if (value.length > maxLen) {
    throw new IpcInputError(field, `length > ${maxLen} (got ${value.length})`);
  }
  if (/[\r\n]/.test(value)) {
    throw new IpcInputError(field, `must be single-line (no \\r / \\n)`);
  }
  if (value.includes('---')) {
    throw new IpcInputError(field, `must not contain "---" (防 frontmatter 注入)`);
  }
  return value;
}

/**
 * 校验 markdown body：长度上限 + 禁起首 `---` 行（防把 body 当二级 frontmatter 解析）。
 * 允许换行（markdown 正文本就多行）；不限字符集。
 */
function parseAssetBody(value: unknown, opts: { allowFrontmatterStart?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw new IpcInputError('body', `must be string, got ${typeof value}`);
  }
  if (value.length > ASSET_LIMITS.body) {
    throw new IpcInputError('body', `length > ${ASSET_LIMITS.body} (got ${value.length})`);
  }
  // body 起首不能再开 frontmatter 块（防写出双 frontmatter 文件）；与 AssetEditor renderer 校验对齐
  if (!opts.allowFrontmatterStart && value.split('\n', 1)[0].trim() === '---') {
    throw new IpcInputError('body', `must not start with "---" (防 frontmatter 嵌套)`);
  }
  return value;
}

function parseUserAssetInput(value: unknown): UserAssetInput {
  if (typeof value !== 'object' || value === null) {
    throw new IpcInputError('userAssetInput', 'must be object');
  }
  const v = value as Record<string, unknown>;
  const kind = parseKind(v.kind);
  const adapter = parseUserAdapterRequired(v.adapter);
  const valid = validateAdapterKind(adapter, kind);
  if (!valid.ok) {
    throw new IpcInputError('adapter+kind', valid.reason);
  }
  const name = parseAssetName(v.name);
  const description = parseSingleLineString('description', v.description ?? '', ASSET_LIMITS.description);
  const body = parseAssetBody(v.body ?? '', {
    allowFrontmatterStart: adapter === 'codex-cli' && kind === 'agent',
  });
  const tools = v.tools !== undefined && v.tools !== ''
    ? parseSingleLineString('tools', v.tools, ASSET_LIMITS.tools)
    : undefined;
  const model = v.model !== undefined && v.model !== ''
    ? parseSingleLineString('model', v.model, ASSET_LIMITS.model)
    : undefined;
  return { kind, adapter, name, description, body, tools, model };
}

export function registerAssetsIpc(): void {
  on(IpcInvoke.AssetsListBundled, () => getBundledAssets());

  on(IpcInvoke.AssetsListUser, () => listUserAssets());

  on(IpcInvoke.AssetsGetContent, (_e, kindArg, nameArg, sourceArg, adapterArg) => {
    const kind = parseKind(kindArg);
    const name = parseAssetName(nameArg);
    const source = parseSource(sourceArg);
    const adapter = parseAdapterRequired(adapterArg);
    if (source === 'bundled') {
      const r = getBundledAssetContent(kind, name, adapter);
      if (r.ok) return { ok: true, content: r.content };
      return { ok: false, content: '', reason: r.reason };
    }
    // source === 'user'：adapter/kind 兼容性仍从 shared helper 收口
    const userAdapter = parseUserAdapterRequired(adapter);
    const valid = validateAdapterKind(userAdapter, kind);
    if (!valid.ok) return { ok: false, content: '', reason: valid.reason };
    const r = getUserAssetContent(kind, name, userAdapter);
    if (r.ok) return { ok: true, content: r.content };
    return { ok: false, content: '', reason: r.reason };
  });

  on(IpcInvoke.AssetsSaveUser, (_e, inputArg) => {
    const input = parseUserAssetInput(inputArg);
    return saveUserAsset(input);
  });

  on(IpcInvoke.AssetsSaveBundledAgentRuntime, (_e, adapterArg, nameArg, overrideArg) => {
    const adapter = parseAdapterRequired(adapterArg);
    const name = parseAssetName(nameArg);
    if (!getBundledAssetPath('agent', name, adapter)) {
      return { ok: false, reason: `bundled Agent not found: ${adapter}/${name}` };
    }
    try {
      const override = saveBundledAgentRuntimeOverride(adapter, name, overrideArg);
      return { ok: true, override };
    } catch (error) {
      throw new IpcInputError(
        'override',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  on(IpcInvoke.AssetsResetBundledAgentRuntime, (_e, adapterArg, nameArg) => {
    const adapter = parseAdapterRequired(adapterArg);
    const name = parseAssetName(nameArg);
    if (!getBundledAssetPath('agent', name, adapter)) {
      return { ok: false, reason: `bundled Agent not found: ${adapter}/${name}` };
    }
    resetBundledAgentRuntimeOverride(adapter, name);
    return { ok: true };
  });

  on(IpcInvoke.AssetsListCodexModelProviders, () => listCodexModelProviders());

  on(IpcInvoke.AssetsDeleteUser, (_e, kindArg, nameArg, adapterArg) => {
    const kind = parseKind(kindArg);
    const name = parseAssetName(nameArg);
    const adapter = parseUserAdapterRequired(adapterArg);
    // adapter/kind 兼容性仍从 shared helper 收口
    const valid = validateAdapterKind(adapter, kind);
    if (!valid.ok) return { ok: false, reason: valid.reason };
    return deleteUserAsset(kind, name, adapter);
  });

  on(IpcInvoke.AssetsRevealInFolder, (_e, kindArg, nameArg, sourceArg, adapterArg) => {
    const kind = parseKind(kindArg);
    const name = parseAssetName(nameArg);
    const source = parseSource(sourceArg);
    const adapter = parseAdapterRequired(adapterArg);
    let path: string | null = null;
    if (source === 'bundled') {
      path = getBundledAssetPath(kind, name, adapter);
    } else {
      const userAdapter = parseUserAdapterRequired(adapter);
      const valid = validateAdapterKind(userAdapter, kind);
      if (!valid.ok) return { ok: false, reason: valid.reason };
      path = getUserAssetPath(kind, name, userAdapter);
    }
    if (!path) return { ok: false, reason: `not found: ${source}/${kind}/${name}` };
    try {
      shell.showItemInFolder(path);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  });
}
