import { useEffect, useRef } from 'react';
import { confirmDialog } from '@renderer/lib/confirm-dialog';

export interface RuntimeChange {
  adapterId: string;
  kind: 'permission' | 'sandbox';
  value: string | null;
  remote?: boolean;
}

/** One confirmation policy for Local and Remote controls; abandoned dialogs grant no mutation. */
export function useRuntimeChangeConfirmation(identity: string) {
  const currentIdentity = useRef(identity);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  currentIdentity.current = identity;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, [identity]);

  return async (change: RuntimeChange): Promise<boolean> => {
    const unrestricted = change.kind === 'permission'
      ? change.value === 'bypassPermissions'
      : change.value === (change.adapterId === 'codex-cli' ? 'danger-full-access' : 'off');
    if (!unrestricted) return mounted.current && currentIdentity.current === identity;

    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const permission = change.kind === 'permission';
    const timing = change.adapterId === 'codex-cli'
      ? '从下一轮生效，当前轮次继续运行。'
      : change.adapterId === 'claude-code'
        ? '当前会话会重启。'
        : permission ? '' : '当前轮结束后会重启会话。';
    try {
      const approved = await confirmDialog({
        title: permission ? '切换到不再询问？' : '将沙盒设为完全开放？',
        message: permission
          ? '执行命令、修改文件时不再逐项询问。\n访问范围仍由「沙盒」限制。'
          : change.remote
            ? '允许读写远端工作区内的文件。\n是否询问由「权限」设置决定。'
            : '允许读写任意文件、执行命令。\n是否询问由「权限」设置决定。',
        detail: timing + (permission && change.remote ? '仍受远端工作区边界限制。' : ''),
        okLabel: '确认切换',
        cancelLabel: '取消',
        destructive: true,
        signal: controller.signal,
      });
      return approved && !controller.signal.aborted && mounted.current
        && currentIdentity.current === identity;
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
}
