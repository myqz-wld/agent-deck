import { useState, type FormEvent, type JSX } from 'react';

import type {
  RemoteHostCredentialKind,
  RemoteHostProfileDraftDto,
  RemoteHostProfileDto,
} from '@shared/remote-host';

interface RemoteProfileFormProps {
  profile: RemoteHostProfileDto | null;
  busy: boolean;
  onSave(draft: RemoteHostProfileDraftDto): Promise<void>;
  onClose(): void;
}

function initialDraft(profile: RemoteHostProfileDto | null): RemoteHostProfileDraftDto {
  const endpoint = profile?.endpoint;
  return {
    label: profile?.label ?? '',
    topology: profile?.topology === 'relay' ? 'relay' : 'server-core',
    hostname: endpoint?.hostname ?? '',
    port: endpoint?.port ?? 22,
    username: endpoint?.username ?? 'agentdeck',
    expectedInstanceId: endpoint?.expectedInstanceId ?? null,
    hostKeyAlias: endpoint?.hostKeyAlias ?? null,
    identitySelectionId: null,
    knownHostsSelectionId: null,
  };
}

export function RemoteProfileForm({
  profile,
  busy,
  onSave,
  onClose,
}: RemoteProfileFormProps): JSX.Element {
  const [draft, setDraft] = useState(() => initialDraft(profile));
  const [identityChosen, setIdentityChosen] = useState(
    profile?.credentials.identityFileConfigured ?? false,
  );
  const [knownHostsChosen, setKnownHostsChosen] = useState(
    profile?.credentials.knownHostsFileConfigured ?? false,
  );
  const [error, setError] = useState<string | null>(null);

  const choose = async (kind: RemoteHostCredentialKind): Promise<void> => {
    setError(null);
    try {
      const selection = await window.api.chooseRemoteHostCredential(kind);
      if (!selection) return;
      if (kind === 'identity-file') {
        setDraft((current) => ({ ...current, identitySelectionId: selection.selectionId }));
        setIdentityChosen(true);
      } else {
        setDraft((current) => ({ ...current, knownHostsSelectionId: selection.selectionId }));
        setKnownHostsChosen(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!identityChosen || !knownHostsChosen) {
      setError('必须分别选择 SSH 私钥和固定的 known_hosts 文件。');
      return;
    }
    setError(null);
    try {
      await onSave({
        ...draft,
        label: draft.label.trim(),
        hostname: draft.hostname.trim(),
        username: draft.username.trim(),
        expectedInstanceId: draft.expectedInstanceId?.trim() || null,
        hostKeyAlias: draft.hostKeyAlias?.trim() || null,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-4">
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-xl rounded-lg border border-white/15 bg-[#17191f] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{profile ? '编辑远程主机' : '添加远程主机'}</h2>
          <button type="button" onClick={onClose} className="rounded px-2 text-deck-muted hover:bg-white/10">×</button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-[11px]">
          <Field label="名称">
            <input required value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 outline-none focus:border-blue-400/50" />
          </Field>
          <Field label="拓扑">
            <select value={draft.topology} onChange={(e) => setDraft({ ...draft, topology: e.target.value as RemoteHostProfileDraftDto['topology'] })} className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 outline-none focus:border-blue-400/50">
              <option value="server-core">Server Core</option>
              <option value="relay">Relay</option>
            </select>
          </Field>
          <Field label="主机名">
            <input required value={draft.hostname} onChange={(e) => setDraft({ ...draft, hostname: e.target.value })} className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 outline-none focus:border-blue-400/50" placeholder="core.example.com" />
          </Field>
          <Field label="SSH 端口">
            <input required type="number" min={1} max={65535} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 outline-none focus:border-blue-400/50" />
          </Field>
          <Field label="SSH 用户名">
            <input required value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 outline-none focus:border-blue-400/50" />
          </Field>
          <Field label="主机密钥别名（可选）">
            <input value={draft.hostKeyAlias ?? ''} onChange={(e) => setDraft({ ...draft, hostKeyAlias: e.target.value || null })} className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 outline-none focus:border-blue-400/50" />
          </Field>
          <Field label="预期 instanceId（可选）">
            <input value={draft.expectedInstanceId ?? ''} onChange={(e) => setDraft({ ...draft, expectedInstanceId: e.target.value || null })} className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 outline-none focus:border-blue-400/50" />
          </Field>
          <div />
          <CredentialButton label="SSH 私钥" chosen={identityChosen} onClick={() => void choose('identity-file')} />
          <CredentialButton label="固定 known_hosts" chosen={knownHostsChosen} onClick={() => void choose('known-hosts-file')} />
        </div>
        <p className="mt-3 text-[10px] text-deck-muted">
          文件路径仅保存在 Electron 主进程，不会发送给页面或远程 Core。主机密钥不会自动接受。
        </p>
        {error && <div role="alert" className="mt-2 rounded bg-red-500/15 p-2 text-[11px] text-red-200">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-[11px] text-deck-muted hover:bg-white/10">取消</button>
          <button type="submit" disabled={busy} className="rounded bg-blue-500 px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50">
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return <label className="space-y-1"><span className="text-deck-muted">{label}</span>{children}</label>;
}

function CredentialButton({
  label,
  chosen,
  onClick,
}: {
  label: string;
  chosen: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="rounded border border-white/10 p-2 text-left hover:bg-white/5">
      <span className="block text-deck-muted">{label}</span>
      <span className={chosen ? 'text-emerald-300' : 'text-amber-300'}>
        {chosen ? '已在主进程配置' : '请选择文件'}
      </span>
    </button>
  );
}
