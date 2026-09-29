import type { JSX } from 'react';
import { SvgIcon, type SvgIconProps } from './SvgIcon';
export function TerminalIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></SvgIcon>;
}
export function SearchIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></SvgIcon>;
}
export function GlobeIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></SvgIcon>;
}
export function BrowserWindowIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></SvgIcon>;
}
export function ListChecksIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m3 6 2 2 3-4M11 6h10M11 12h10M11 18h10" /><rect x="3" y="11" width="4" height="4" rx="1" /><path d="M4 20h2" /></SvgIcon>;
}
export function BrainIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M12 5c-3-4-7-1-6 2-4 1-4 6-1 7-2 4 2 8 7 5V5Zm0 0c3-4 7-1 6 2 4 1 4 6 1 7 2 4-2 8-7 5M6 7l2 2M5 14h3M18 7l-2 2M19 14h-3" /></SvgIcon>;
}
export function PlugIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4" /></SvgIcon>;
}
export function SparklesIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM3 3v3M1.5 4.5h3" /></SvgIcon>;
}
export function BranchIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10M18 7v2c0 4-12 3-12 7" /></SvgIcon>;
}
