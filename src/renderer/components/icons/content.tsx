import type { JSX } from 'react';
import { SvgIcon, type SvgIconProps } from './SvgIcon';

export function FolderIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M3 6h7l2 2h9v11H3V6Z" /></SvgIcon>;
}

export function FolderOpenIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M3 18V6h7l2 2h8v3" /><path d="m3 18 2-7h17l-2 7H3Z" /></SvgIcon>;
}

export function FileIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h4" /></SvgIcon>;
}

export function FileTextIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h4M9 13h6M9 17h6" /></SvgIcon>;
}

export function ImageIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 2-2 5 4" /></SvgIcon>;
}

export function PaperclipIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m9 12 6.4-6.4a3 3 0 1 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7.1-7.1l8.5-8.5" /></SvgIcon>;
}
