import type { ComponentType, JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { AlertTriangleIcon, BanIcon, BranchIcon, BrainIcon, CircleCheckIcon, CircleCloseIcon,
  ClockIcon, CollapseIcon, FileDiffIcon, ImageIcon, InfoIcon, ListChecksIcon, MessageIcon,
  PauseIcon, PencilIcon, PlayIcon, QuestionIcon, SearchIcon, ShieldIcon, StopIcon, UsersIcon,
  WrenchIcon, type SvgIconProps } from '../icons';
import { ToolIcon } from './tool-icon';
import { turnOutcome } from './turn-outcome';

const ICONS = {
  tool: WrenchIcon, message: MessageIcon, image: ImageIcon, edit: PencilIcon,
  compaction: CollapseIcon, agent: BranchIcon, permission: ShieldIcon, question: QuestionIcon,
  plan: ListChecksIcon, waiting: AlertTriangleIcon, cancelled: BanIcon, success: CircleCheckIcon,
  interrupted: PauseIcon, stopped: StopIcon, working: PlayIcon, idle: ClockIcon,
  error: CircleCloseIcon, info: InfoIcon, team: UsersIcon, task: ListChecksIcon,
  thinking: BrainIcon, diff: FileDiffIcon, review: SearchIcon,
} satisfies Record<string, ComponentType<SvgIconProps>>;
export type ActivityIconKind = keyof typeof ICONS;

export function ActivityIcon({ kind, tool, className = 'h-3.5 w-3.5 shrink-0 text-deck-muted' }: {
  kind: ActivityIconKind;
  tool?: { name: string; kind?: unknown; input?: unknown };
  className?: string;
}): JSX.Element {
  const Icon = ICONS[kind];
  return kind === 'tool' && tool
    ? <ToolIcon tool={tool.name} kind={tool.kind} input={tool.input} className={className} />
    : <Icon className={className} />;
}

export function EventIcon({ event, className }: { event: AgentEvent; className?: string }): JSX.Element {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown> : {};
  let kind: ActivityIconKind = 'info';
  switch (event.kind) {
    case 'tool-use-start':
    case 'tool-use-end': kind = 'tool'; break;
    case 'message':
    case 'message-display': kind = 'message'; break;
    case 'thinking': kind = payload.plan ? 'plan' : 'thinking'; break;
    case 'file-changed': kind = 'edit'; break;
    case 'context-compaction-start':
    case 'context-compaction-end': kind = 'compaction'; break;
    case 'subagent-start':
    case 'subagent-end': kind = 'agent'; break;
    case 'finished': kind = turnOutcome(payload).icon; break;
    case 'session-start': kind = 'working'; break;
    case 'session-end': kind = 'stopped'; break;
    case 'team-task-created': kind = 'task'; break;
    case 'team-task-completed': kind = 'success'; break;
    case 'team-teammate-idle': kind = 'idle'; break;
    case 'waiting-for-user': {
      const type = typeof payload.type === 'string' ? payload.type : '';
      kind = type.endsWith('-cancelled') ? 'cancelled'
        : type.includes('permission-request') ? 'permission'
          : type === 'ask-user-question' ? 'question'
            : type === 'exit-plan-mode' ? 'plan'
              : type === 'diff-review' ? 'diff' : 'waiting';
      break;
    }
  }
  return <ActivityIcon kind={kind} className={className} tool={{
    name: typeof payload.toolName === 'string' ? payload.toolName : '工具',
    kind: payload.toolKind, input: payload.toolInput,
  }} />;
}
