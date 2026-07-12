import type { JSX } from 'react';
import { SvgIcon, type SvgIconProps } from './SvgIcon';

export function AlertTriangleIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4.5" /><path d="M12 17h.01" /></SvgIcon>;
}

export function InfoIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></SvgIcon>;
}

export function PlusIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M12 5v14M5 12h14" /></SvgIcon>;
}

export function CloseIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m6 6 12 12M18 6 6 18" /></SvgIcon>;
}

export function CheckIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m5 12 4.5 4.5L19 7" /></SvgIcon>;
}

export function CheckboxIcon({ checked = false, ...props }: SvgIconProps & { checked?: boolean }): JSX.Element {
  return (
    <SvgIcon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" fill={checked ? 'currentColor' : 'none'} />
      {checked && <path d="m8 12 2.5 2.5L16 9" className="text-deck-bg" />}
    </SvgIcon>
  );
}

export function ClockIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></SvgIcon>;
}

export function CircleCheckIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></SvgIcon>;
}

export function CircleCloseIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></SvgIcon>;
}

export function BanIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></SvgIcon>;
}

export function PushpinIcon({ filled = false, ...props }: SvgIconProps & { filled?: boolean }): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M9 3h6l-.8 6 2.8 2v2H7v-2l2.8-2L9 3Z" fill={filled ? 'currentColor' : 'none'} />
      <path d="M12 13v8" />
    </SvgIcon>
  );
}

export function CopyIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></SvgIcon>;
}

export function SaveIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M5 3h12l2 2v16H5V3Z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></SvgIcon>;
}

export function TrashIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></SvgIcon>;
}

export function PencilIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z" /><path d="m13.8 6.7 3.5 3.5" /></SvgIcon>;
}

export function EyeIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></SvgIcon>;
}

export function SendIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m3 4 18 8-18 8 3-8-3-8Z" /><path d="M6 12h15" /></SvgIcon>;
}

export function HandOffIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M4 7h11m-4-4 4 4-4 4M20 17H9m4-4-4 4 4 4" /></SvgIcon>;
}

export function StopIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" /></SvgIcon>;
}

export function ArchiveIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M4 7h16v14H4V7ZM3 3h18v4H3V3Z" /><path d="M9 11h6" /></SvgIcon>;
}

export function VolumeIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="M16 9c1.5 1.7 1.5 4.3 0 6M19 6c3.3 3.3 3.3 8.7 0 12" /></SvgIcon>;
}

export function PlayIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m8 5 11 7-11 7V5Z" fill="currentColor" /></SvgIcon>;
}

export function RefreshIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.2 8A7 7 0 0 1 18 6l2 2M17.8 16A7 7 0 0 1 6 18l-2-2" /></SvgIcon>;
}

export function SearchIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></SvgIcon>;
}

export function TerminalIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 16h4" /></SvgIcon>;
}

export function WrenchIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M14 6a5 5 0 0 0-6-2l3 3-4 4-3-3a5 5 0 0 0 6 6l6 6 4-4-6-6a5 5 0 0 0 0-4Z" /></SvgIcon>;
}
