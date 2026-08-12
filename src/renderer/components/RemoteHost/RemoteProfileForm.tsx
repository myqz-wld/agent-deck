import { useId, useRef, useState, type FormEvent, type JSX } from 'react';

import type {
  RemoteHostConnectionSelectionDto,
  RemoteHostEndpointDto,
  RemoteHostProfileDraftDto,
  RemoteHostProfileDto,
} from '@shared/remote-host';
import { CloseIcon } from '../icons';
import { useModalFocus } from '../use-modal-focus';

const INPUT_CLASS = 'w-full rounded-md border border-white/[0.08] bg-black/[0.12] px-2.5 py-2 text-[11px] outline-none transition placeholder:text-deck-muted/40 hover:border-white/[0.12] focus:border-blue-300/30 focus:bg-blue-400/[0.035]';

interface RemoteProfileFormProps {
  profile: RemoteHostProfileDto | null;
  busy: boolean;
  onSave(draft: RemoteHostProfileDraftDto): Promise<void>;
  onClose(): void;
}

function initialDraft(profile: RemoteHostProfileDto | null): RemoteHostProfileDraftDto {
  return { label: profile?.label ?? '', connectionSelectionId: null };
}

export function RemoteProfileForm({
  profile,
  busy,
  onSave,
  onClose,
}: RemoteProfileFormProps): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(() => initialDraft(profile));
  const [selection, setSelection] = useState<RemoteHostConnectionSelectionDto | null>(null);
  const [connectionChosen, setConnectionChosen] = useState(
    profile?.credentials.connectionCredentialConfigured ?? false,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const choosingRef = useRef(false);
  const savingRef = useRef(false);
  const effectiveBusy = busy || saving;
  useModalFocus({ blocked: effectiveBusy, dialogRef, onClose });

  const chooseConnection = async (): Promise<void> => {
    if (effectiveBusy || choosingRef.current) return;
    choosingRef.current = true;
    setError(null);
    try {
      const next = await window.api.chooseRemoteHostConnection();
      if (!next) return;
      setSelection(next);
      setConnectionChosen(true);
      setDraft((current) => ({
        connectionSelectionId: next.selectionId,
        label: current.label.trim() ? current.label : next.label,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      choosingRef.current = false;
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (effectiveBusy || savingRef.current) return;
    if (!connectionChosen) {
      setError('请先导入服务端签发的连接凭证。');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, label: draft.label.trim() });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const endpoint = selection?.endpoint ?? profile?.endpoint ?? null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <form
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => void submit(event)}
        className="max-h-[90%] w-full max-w-lg overflow-y-auto rounded-xl border border-white/[0.09] bg-deck-bg-strong p-4 shadow-2xl scrollbar-deck"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 id={titleId} className="text-[13px] font-medium">{profile ? '编辑远程连接' : '添加远程连接'}</h2>
            <p className="mt-0.5 text-[10px] text-deck-muted">导入服务端签发的单个连接凭证即可。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={effectiveBusy}
            aria-label="关闭远程连接表单"
            className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">名称</span>
          <input
          required
          disabled={effectiveBusy}
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            className={INPUT_CLASS}
            placeholder="例如：生产环境"
          />
        </label>

        <button
          type="button"
          disabled={effectiveBusy}
          onClick={() => void chooseConnection()}
          className="mt-3 w-full rounded-lg border border-blue-300/10 bg-gradient-to-r from-blue-500/[0.08] via-blue-500/[0.025] to-transparent p-3 text-left transition hover:border-blue-300/20 hover:from-blue-500/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium text-deck-text">连接凭证</div>
              <div className="mt-0.5 text-[9px] text-deck-muted/70">
                包含登录密钥、服务器地址和固定的主机身份
              </div>
            </div>
            <span className={`shrink-0 rounded px-2 py-1 text-[10px] ${
              connectionChosen
                ? 'border border-emerald-300/15 bg-emerald-400/[0.08] text-emerald-200'
                : 'border border-blue-300/10 bg-blue-400/[0.07] text-blue-100/80'
            }`}>
              {connectionChosen ? (selection ? '已导入' : '已配置') : '选择文件…'}
            </span>
          </div>
        </button>

        {endpoint && <ConnectionSummary endpoint={endpoint} />}

        <p className="mt-3 text-[10px] leading-relaxed text-deck-muted">
          Agent Deck 会把登录密钥和主机身份保存到应用私有目录，并强制校验服务器身份；页面不会接触密钥或内部连接字段。导入后可安全删除传输用的凭证副本。
        </p>
        {error && (
          <div role="alert" className="mt-2 rounded bg-status-waiting/10 p-2 text-[11px] text-status-waiting">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={effectiveBusy} className="rounded px-3 py-1.5 text-[11px] text-deck-muted hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40">取消</button>
          <button type="submit" disabled={effectiveBusy} className="rounded-md border border-blue-300/15 bg-blue-400/10 px-3 py-1.5 text-[11px] text-blue-100 transition hover:border-blue-300/25 hover:bg-blue-400/15 disabled:opacity-50">
            {effectiveBusy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConnectionSummary({ endpoint }: { endpoint: RemoteHostEndpointDto }): JSX.Element {
  return (
    <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/[0.12] px-3 py-2 text-[10px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-deck-muted">连接地址</span>
        <span className="truncate text-deck-text">{endpoint.username}@{endpoint.hostname}:{endpoint.port}</span>
      </div>
      {endpoint.hostKeyFingerprint && (
        <div className="mt-1 flex items-center justify-between gap-3">
          <span className="shrink-0 text-deck-muted">服务器指纹</span>
          <span className="min-w-0 truncate font-mono text-[9px] text-deck-muted/90">
            {endpoint.hostKeyFingerprint}
          </span>
        </div>
      )}
    </div>
  );
}
