import type { JSX } from 'react';

import { ArchiveIcon, RefreshIcon, TrashIcon } from './icons';
import {
  SessionActionsContextMenu,
  type SessionContextMenuPosition,
} from './SessionActionsContextMenu';

export function HistorySessionActionsMenu({
  archived,
  onClose,
  onArchive,
  onDelete,
  onReactivate,
  onUnarchive,
  position,
}: {
  archived: boolean;
  onClose(): void;
  onArchive?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onReactivate?: () => Promise<void>;
  onUnarchive?: () => Promise<void>;
  position: SessionContextMenuPosition;
}): JSX.Element {
  const archiveAction = archived
    ? onUnarchive ? {
        icon: <RefreshIcon className="mr-1 inline h-3 w-3" />,
        label: '取消归档',
        run: onUnarchive,
      } : null
    : onArchive ? {
        icon: <ArchiveIcon className="mr-1 inline h-3 w-3" />,
        label: '归档',
        run: onArchive,
      } : null;
  return (
    <SessionActionsContextMenu
      position={position}
      onClose={onClose}
      actions={[
        ...(archiveAction ? [archiveAction] : []),
        ...(onReactivate
          ? [{
              icon: <RefreshIcon className="mr-1 inline h-3 w-3" />,
              label: '重新激活',
              run: onReactivate,
            }]
          : []),
        ...(onDelete ? [{
          danger: true,
          icon: <TrashIcon className="mr-1 inline h-3 w-3" />,
          label: '删除',
          run: onDelete,
        }] : []),
      ]}
    />
  );
}
