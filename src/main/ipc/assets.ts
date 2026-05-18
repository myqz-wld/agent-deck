/**
 * Assets Library IPC handlers（CHANGELOG_57 C2 / plan codex-handoff-team-alignment-20260518
 * §P3 Step 3.4 双 adapter cascade）。
 *
 * 6 个 channel 收口资产库读写：
 *   - AssetsListBundled / AssetsListUser    —— 列表
 *   - AssetsGetContent                      —— 单个 asset 完整 md（含 frontmatter）
 *   - AssetsSaveUser / AssetsDeleteUser     —— 用户自定义 CRUD
 *   - AssetsRevealInFolder                  —— shell.showItemInFolder 跨平台显示
 *
 * 入参校验：name 走 isSafeName（slug `[a-z0-9-]+`，长度 1-64），kind 严格枚举，
 * source 严格枚举，UserAssetInput 委托 user-assets.saveUserAsset 内部校验。
 * 所有失败统一返回 `{ ok: false, reason }`，renderer 透传给用户。
 *
 * **plan §P3 Step 3.4 升级**：AssetsGetContent / AssetsRevealInFolder 加 adapter 第 4 参数：
 * - source==='bundled'：adapter 必传（'claude-code' / 'codex-cli'）—— bundled 双 root narrow
 *   key，不传或非法直接 reject
 * - source==='user'：adapter 忽略（user 资产无 plugin scope，renderer 传 null）
 */
import { shell } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type { AssetKind, AssetSource, UserAssetInput } from '@shared/types';
import { ASSET_LIMITS } from '@shared/types';
import { on, IpcInputError, parseStringId } from './_helpers';
import {
  getBundledAssets,
  getBundledAssetContent,
  getBundledAssetPath,
  isSafeName,
  type BundledAdapter,
} from '@main/bundled-assets';
import {
  deleteUserAsset,
  getUserAssetContent,
  getUserAssetPath,
  listUserAssets,
  saveUserAsset,
} from '@main/user-assets';

const KIND_VALUES: ReadonlyArray<AssetKind> = ['agent', 'skill'];
const SOURCE_VALUES: ReadonlyArray<AssetSource> = ['bundled', 'user'];
const BUNDLED_ADAPTER_VALUES: ReadonlyArray<BundledAdapter> = ['claude-code', 'codex-cli'];

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
 * plan §P3 Step 3.4：bundled adapter narrow key 入参校验。
 * - source==='bundled'：必传 'claude-code' / 'codex-cli'，缺失或非法 throw
 * - source==='user'：caller 应传 null（renderer 直接透传 `asset.adapter`，user 资产是 null）
 *
 * 返回 BundledAdapter（bundled 路径用）/ null（user 路径用）；caller 必须按 source 自己 narrow
 * 拒绝非法组合（如 source='bundled' + adapter=null）。
 */
function parseBundledAdapterOrNull(value: unknown): BundledAdapter | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !BUNDLED_ADAPTER_VALUES.includes(value as BundledAdapter)) {
    throw new IpcInputError(
      'adapter',
      `must be one of ${BUNDLED_ADAPTER_VALUES.join('|')} or null, got ${String(value)}`,
    );
  }
  return value as BundledAdapter;
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
function parseAssetBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new IpcInputError('body', `must be string, got ${typeof value}`);
  }
  if (value.length > ASSET_LIMITS.body) {
    throw new IpcInputError('body', `length > ${ASSET_LIMITS.body} (got ${value.length})`);
  }
  // body 起首不能再开 frontmatter 块（防写出双 frontmatter 文件）；与 AssetEditor renderer 校验对齐
  if (value.split('\n', 1)[0].trim() === '---') {
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
  const name = parseAssetName(v.name);
  const description = parseSingleLineString('description', v.description ?? '', ASSET_LIMITS.description);
  const body = parseAssetBody(v.body ?? '');
  const tools = v.tools !== undefined && v.tools !== ''
    ? parseSingleLineString('tools', v.tools, ASSET_LIMITS.tools)
    : undefined;
  const model = v.model !== undefined && v.model !== ''
    ? parseSingleLineString('model', v.model, ASSET_LIMITS.model)
    : undefined;
  return { kind, name, description, body, tools, model };
}

export function registerAssetsIpc(): void {
  on(IpcInvoke.AssetsListBundled, () => getBundledAssets());

  on(IpcInvoke.AssetsListUser, () => listUserAssets());

  on(IpcInvoke.AssetsGetContent, (_e, kindArg, nameArg, sourceArg, adapterArg) => {
    const kind = parseKind(kindArg);
    const name = parseAssetName(nameArg);
    const source = parseSource(sourceArg);
    const adapter = parseBundledAdapterOrNull(adapterArg);
    if (source === 'bundled') {
      if (adapter === null) {
        // plan §P3 Step 3.4：bundled 必带 adapter narrow key（claude-code / codex-cli）
        return { ok: false, content: '', reason: `bundled asset must include adapter narrow key (got null)` };
      }
      const r = getBundledAssetContent(kind, name, adapter);
      if (r.ok) return { ok: true, content: r.content };
      return { ok: false, content: '', reason: r.reason };
    }
    const r = getUserAssetContent(kind, name);
    if (r.ok) return { ok: true, content: r.content };
    return { ok: false, content: '', reason: r.reason };
  });

  on(IpcInvoke.AssetsSaveUser, (_e, inputArg) => {
    const input = parseUserAssetInput(inputArg);
    return saveUserAsset(input);
  });

  on(IpcInvoke.AssetsDeleteUser, (_e, kindArg, nameArg) => {
    const kind = parseKind(kindArg);
    const name = parseAssetName(nameArg);
    return deleteUserAsset(kind, name);
  });

  on(IpcInvoke.AssetsRevealInFolder, (_e, kindArg, nameArg, sourceArg, adapterArg) => {
    const kind = parseKind(kindArg);
    const name = parseAssetName(nameArg);
    const source = parseSource(sourceArg);
    const adapter = parseBundledAdapterOrNull(adapterArg);
    let path: string | null = null;
    if (source === 'bundled') {
      if (adapter === null) {
        return { ok: false, reason: `bundled asset must include adapter narrow key (got null)` };
      }
      path = getBundledAssetPath(kind, name, adapter);
    } else {
      path = getUserAssetPath(kind, name);
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
