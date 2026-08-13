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
  onArchive(): Promise<void>;
  onDelete(): Promise<void>;
  onReactivate?: () => Promise<void>;
  onUnarchive(): Promise<void>;
  position: SessionContextMenuPosition;
}): JSX.Element {
  return (
    <SessionActionsContextMenu
      position={position}
      onClose={onClose}
      actions={[
        archived
          ? {
              icon: <RefreshIcon className="mr-1 inline h-3 w-3" />,
              label: '取消归档',
              run: onUnarchive,
            }
          : {
              icon: <ArchiveIcon className="mr-1 inline h-3 w-3" />,
              label: '归档',
              run: onArchive,
            },
        ...(onReactivate
          ? [{
              icon: <RefreshIcon className="mr-1 inline h-3 w-3" />,
              label: '重新激活',
              run: onReactivate,
            }]
          : []),
        {
          danger: true,
          icon: <TrashIcon className="mr-1 inline h-3 w-3" />,
          label: '删除',
          run: onDelete,
        },
      ]}
    />
  );
}
