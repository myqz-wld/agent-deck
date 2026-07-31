/**
 * Assets Library IPC handlers（CHANGELOG_57 C2 / plan codex-handoff-team-alignment-20260518
 * §P3 Step 3.4 multi-adapter cascade / plan assets-codex-user-and-ui-unify-20260521 §D3 §D5 §D7
 * 三 adapter user 资产只读发现 + UI sub-tab 统一改造）。
 *
 * Channels in this module cover bundled/user asset reads, bundled Agent runtime
 * deltas, Codex config-profile suggestions, and Finder reveal:
 *   - AssetsListBundled / AssetsListUser    —— 列表
 *   - AssetsGetContent                      —— 单个 asset 完整内容
 *   - AssetsRevealInFolder                  —— shell.showItemInFolder 跨平台显示
 *
 * 入参校验：bundled name 走 Agent Deck slug，user name 走各原生 CLI 共用安全字符集；
 * kind/source/adapter 严格枚举。所有失败统一返回 `{ ok: false, reason }`。
 *
 * **plan assets-codex-user-and-ui-unify-20260521 §D7 升级**：
 * - `AssetMeta.adapter` user 资产也带 ('claude-code' | 'codex-cli' | 'grok-build')，null 删除
 * - `AssetsGetContent` / `AssetsRevealInFolder` source==='user' 时也必传 adapter
 *   （user 资产现也按 adapter 派发到不同 root：~/.claude/{agents,skills}/ vs ~/.codex/{agents,skills}/）
 * - `validateAdapterKind` 保留为 adapter/kind 兼容性收口点；当前三种 adapter 的 agent/skill 组合都支持
 */
import { shell } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import type {
  AssetAdapter,
  AssetKind,
  AssetSource,
  UserAssetAdapter,
} from '@shared/types';
import { ASSET_LIMITS, isNativeAssetName, validateAdapterKind } from '@shared/types';
import { on, IpcInputError, parseStringId } from './_helpers';
import {
  getBundledAssets,
  getBundledAssetContent,
  getBundledAssetPath,
  isSafeName,
} from '@main/bundled-assets';
import {
  getUserAssetContent,
  getUserAssetPath,
  listUserAssets,
} from '@main/user-assets';
import {
  resetBundledAgentRuntimeOverride,
  saveBundledAgentRuntimeOverride,
} from '@main/bundled-agent-runtime-overrides';
import { listCodexConfigProfiles } from '@main/codex-config/profiles';
import { listClaudeGatewayProfiles } from '@main/adapters/claude-code/gateway-profiles';

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
  'grok-build',
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

function parseAssetName(value: unknown, source: AssetSource): string {
  const maxLength = source === 'user' ? ASSET_LIMITS.nativeName : ASSET_LIMITS.name;
  const name = parseStringId('name', value, maxLength);
  const valid = source === 'user' ? isNativeAssetName(name) : isSafeName(name);
  if (!valid) {
    throw new IpcInputError(
      'name',
      `must match the ${source === 'user' ? 'native user asset' : 'Agent Deck bundled asset'} name rule, length 1-${maxLength} (got "${name}")`,
    );
  }
  return name;
}

export function registerAssetsIpc(): void {
  on(IpcInvoke.AssetsListBundled, () => getBundledAssets());

  on(IpcInvoke.AssetsListUser, () => listUserAssets());

  on(IpcInvoke.AssetsGetContent, (_e, kindArg, nameArg, sourceArg, adapterArg, pathArg) => {
    const kind = parseKind(kindArg);
    const source = parseSource(sourceArg);
    const adapter = parseAdapterRequired(adapterArg);
    const name = parseAssetName(nameArg, source);
    const pathHint = pathArg === undefined || pathArg === null ? undefined : parseStringId('path', pathArg, 4096);
    if (source === 'bundled') {
      const r = getBundledAssetContent(kind, name, adapter);
      if (r.ok) return { ok: true, content: r.content };
      return { ok: false, content: '', reason: r.reason };
    }
    // source === 'user'：adapter/kind 兼容性仍从 shared helper 收口
    const userAdapter = parseUserAdapterRequired(adapter);
    const valid = validateAdapterKind(userAdapter, kind);
    if (!valid.ok) return { ok: false, content: '', reason: valid.reason };
    const r = getUserAssetContent(kind, name, userAdapter, pathHint);
    if (r.ok) return { ok: true, content: r.content };
    return { ok: false, content: '', reason: r.reason };
  });

  on(IpcInvoke.AssetsSaveBundledAgentRuntime, (_e, adapterArg, nameArg, overrideArg) => {
    const adapter = parseAdapterRequired(adapterArg);
    const name = parseAssetName(nameArg, 'bundled');
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
    const name = parseAssetName(nameArg, 'bundled');
    if (!getBundledAssetPath('agent', name, adapter)) {
      return { ok: false, reason: `bundled Agent not found: ${adapter}/${name}` };
    }
    resetBundledAgentRuntimeOverride(adapter, name);
    return { ok: true };
  });

  on(IpcInvoke.AssetsListClaudeGatewayProfiles, () => listClaudeGatewayProfiles());
  on(IpcInvoke.AssetsListCodexConfigProfiles, () => listCodexConfigProfiles());

  on(IpcInvoke.AssetsRevealInFolder, (_e, kindArg, nameArg, sourceArg, adapterArg, pathArg) => {
    const kind = parseKind(kindArg);
    const source = parseSource(sourceArg);
    const adapter = parseAdapterRequired(adapterArg);
    const name = parseAssetName(nameArg, source);
    const pathHint = pathArg === undefined || pathArg === null ? undefined : parseStringId('path', pathArg, 4096);
    let path: string | null = null;
    if (source === 'bundled') {
      path = getBundledAssetPath(kind, name, adapter);
    } else {
      const userAdapter = parseUserAdapterRequired(adapter);
      const valid = validateAdapterKind(userAdapter, kind);
      if (!valid.ok) return { ok: false, reason: valid.reason };
      path = getUserAssetPath(kind, name, userAdapter, pathHint);
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
