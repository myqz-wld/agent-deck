import type { JSX } from 'react';
import { SvgIcon, type SvgIconProps } from './SvgIcon';

export function FolderOpenIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M3 18V6h7l2 2h8v3" /><path d="m3 18 2-7h17l-2 7H3Z" /></SvgIcon>;
}

export function FileTextIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M6 3h8l4 4v14H6V3Z" /><path d="M14 3v5h4M9 13h6M9 17h6" /></SvgIcon>;
}

export function ImageIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 2-2 5 4" /></SvgIcon>;
}
