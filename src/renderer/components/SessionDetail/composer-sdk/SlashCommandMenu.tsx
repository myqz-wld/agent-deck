import type { JSX } from 'react';
import type { SessionCommandDescriptor } from '@shared/types';
import { matchingSessionCommands } from '@shared/session-commands';

export function commandCompletion(command: SessionCommandDescriptor): string {
  return `/${command.name}${command.argumentHint ? ' ' : ''}`;
}

export function SlashCommandMenu({
  commands,
  text,
  onChoose,
  placement = 'above',
}: {
  commands: readonly SessionCommandDescriptor[];
  text: string;
  onChoose: (value: string) => void;
  placement?: 'above' | 'inset';
}): JSX.Element | null {
  const matches = matchingSessionCommands(commands, text);
  if (matches.length === 0) return null;
  const position = placement === 'above'
    ? 'bottom-full left-0 right-0 mb-1'
    : 'left-2 right-2 top-2';
  return (
    <div
      role="listbox"
      aria-label="可用命令"
      className={`absolute z-20 max-h-52 overflow-y-auto rounded border border-deck-border bg-[#1b1b20] p-1 shadow-xl ${position}`}
    >
      {matches.map((command) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected="false"
          className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-white/[0.08]"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(commandCompletion(command))}
        >
          <code className="shrink-0 text-[11px] text-status-working">
            /{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ''}
          </code>
          {command.description && (
            <span className="min-w-0 truncate text-[10px] text-deck-muted">
              {command.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
