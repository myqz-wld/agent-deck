import type { ComponentProps, JSX } from 'react';
import { SessionModelFields } from '../../SessionModelFields';
import { ErrorBanner } from './ErrorBanner';

type ModelFieldsProps = ComponentProps<typeof SessionModelFields>;

/** Shared runtime/model/thinking presentation for both Local and Remote sessions. */
export function SessionRuntimeFieldsView({
  fields,
  help,
  error,
  onDismissError,
}: {
  fields: ModelFieldsProps;
  help: string;
  error: string | null;
  onDismissError: () => void;
}): JSX.Element {
  const label = fields.adapterId === 'codex-cli'
    ? '模型来源'
    : fields.adapterId === 'claude-code'
      ? '模型网关'
      : '运行设置';
  return (
    <details className="mb-2 rounded border border-deck-border/80 bg-white/[0.02] px-2 py-1.5">
      <summary className="cursor-pointer select-none text-[10px] text-deck-muted">
        {label}、模型与思考程度
        <span className="ml-1 text-deck-muted/60">（下一轮生效）</span>
      </summary>
      <div className="mt-2 space-y-2">
        <SessionModelFields {...fields} />
        <p className="text-[9px] text-deck-muted/65">{help}</p>
        <ErrorBanner message={error} prefix="运行设置失败" onDismiss={onDismissError} />
      </div>
    </details>
  );
}
