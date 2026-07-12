import type { JSX } from 'react';
import { SvgIcon, type SvgIconProps } from './SvgIcon';

export function ShieldIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="M12 3 20 6v5c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6l8-3Z" /></SvgIcon>;
}

export function CrownIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><path d="m4 8 4 3 4-6 4 6 4-3-2 10H6L4 8Z" /><path d="M6 21h12" /></SvgIcon>;
}

export function UsersIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="9" cy="8" r="3" /><path d="M3 20v-2c0-3 2.4-5 6-5s6 2 6 5v2" /><path d="M15 5.5a3 3 0 0 1 0 5.5M17 13c2.4.6 4 2.4 4 5v2" /></SvgIcon>;
}

export function UserIcon(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21c.6-4.7 3.3-7 8-7s7.4 2.3 8 7" /></SvgIcon>;
}
