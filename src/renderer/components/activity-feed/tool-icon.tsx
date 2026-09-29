import type { ComponentType, JSX } from 'react';
import { inferAgentToolKind, isAgentToolKind } from '@shared/tool-kind';
import { FileTextIcon, PencilIcon, SearchIcon, TerminalIcon, GlobeIcon, BrowserWindowIcon,
  ListChecksIcon, BrainIcon, PlugIcon, SparklesIcon, BranchIcon, UsersIcon, SendIcon,
  ClockIcon, ImageIcon, TrashIcon, FolderOpenIcon, HandOffIcon, WrenchIcon, InfoIcon,
  type SvgIconProps } from '../icons';
import { unwrapShellCommand } from './tool-summary';

const KINDS: Record<string, ComponentType<SvgIconProps>> = {
  read: FileTextIcon, edit: PencilIcon, delete: TrashIcon, move: FolderOpenIcon,
  search: SearchIcon, execute: TerminalIcon, think: BrainIcon, fetch: GlobeIcon,
  switch_mode: HandOffIcon,
};
export function ToolIcon({ tool, kind, input, className = 'h-3.5 w-3.5 shrink-0 text-deck-muted' }: {
  tool: string; kind?: unknown; input?: unknown; className?: string;
}): JSX.Element {
  const name = tool.toLowerCase().split('__').at(-1) ?? '';
  const command = (input as { command?: unknown; cmd?: unknown } | null)?.command
    ?? (input as { cmd?: unknown } | null)?.cmd;
  let Icon: ComponentType<SvgIconProps> | undefined;
  if (typeof command === 'string' && /^agent-deck-browser(?:\s|$)/.test(unwrapShellCommand(command))) Icon = BrowserWindowIcon;
  else if (/^(?:task|agent|spawn_agent)$/.test(name)) Icon = BranchIcon;
  else if (/^(?:sendmessage|send_message|followup_task)$/.test(name)) Icon = SendIcon;
  else if (/image|screenshot/.test(name)) Icon = ImageIcon;
  else if (/^(?:clock\.sleep|wait|wait_agent)$/.test(name)) Icon = ClockIcon;
  else if (/skill/.test(name)) Icon = SparklesIcon;
  else if (/plan|todo|^task[_a-z]/.test(name)) Icon = ListChecksIcon;
  else if (/team/.test(name)) Icon = UsersIcon;
  else if (/ask.*question/.test(name)) Icon = InfoIcon;
  const semantic = isAgentToolKind(kind) && kind !== 'other' ? kind : inferAgentToolKind(tool);
  Icon ??= semantic ? KINDS[semantic] : undefined;
  Icon ??= tool.startsWith('mcp__') ? PlugIcon : WrenchIcon;
  return <Icon className={className} />;
}
