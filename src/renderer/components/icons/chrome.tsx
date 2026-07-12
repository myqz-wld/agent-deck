import type { JSX } from 'react';
import { SvgIcon, type SvgIconProps } from './SvgIcon';

export function SettingsIcon(props: SvgIconProps): JSX.Element {
  return (
    <SvgIcon {...props}>
      <path d="M9.7 3.4 10.3 2h3.4l.6 1.4 1.5.6 1.4-.6 2.4 2.4-.6 1.4.6 1.5 1.4.6v3.4l-1.4.6-.6 1.5.6 1.4-2.4 2.4-1.4-.6-1.5.6-.6 1.4h-3.4l-.6-1.4-1.5-.6-1.4.6-2.4-2.4.6-1.4-.6-1.5-1.4-.6V9.3l1.4-.6L5 7.2l-.6-1.4 2.4-2.4 1.4.6 1.5-.6Z" />
      <circle cx="12" cy="11" r="3" />
    </SvgIcon>
  );
}

export function LibraryIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l3-1 3 15-3 .7L16 5Z" /></SvgIcon>;
}

export function ExpandIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></SvgIcon>;
}

export function CollapseIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" /></SvgIcon>;
}

export function ChevronDownIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m6 9 6 6 6-6" /></SvgIcon>;
}

export function ChevronUpIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m6 15 6-6 6 6" /></SvgIcon>;
}

export function ChevronLeftIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m15 18-6-6 6-6" /></SvgIcon>;
}

export function ChevronRightIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m9 18 6-6-6-6" /></SvgIcon>;
}

export function ArrowLeftIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M19 12H5m6-6-6 6 6 6" /></SvgIcon>;
}

export function ArrowRightIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M5 12h14m-6-6 6 6-6 6" /></SvgIcon>;
}

export function ArrowUpIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M12 19V5m-6 6 6-6 6 6" /></SvgIcon>;
}

export function ArrowDownIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M12 5v14m-6-6 6 6 6-6" /></SvgIcon>;
}

export function ReplyIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m10 8-5 4 5 4v-3h4.5c2.5 0 4.2 1.1 5.5 3.5-.4-4.8-2.8-7.5-6.8-7.5H10V8Z" /></SvgIcon>;
}

export function ExternalLinkIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6H5V6h6" /></SvgIcon>;
}
