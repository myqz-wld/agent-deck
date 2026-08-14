import { IpcInvoke } from '@shared/ipc-channels';
import { summarizer } from '@main/session/summarizer/desktop';
import { on } from './_helpers';

/** Registers path-free renderer diagnostics that do not belong to a product page domain. */
export function registerDiagnosticsIpc(): void {
  on(IpcInvoke.SummarizerLastErrors, () => summarizer.getLastErrors());
}
