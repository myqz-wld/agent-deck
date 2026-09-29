import type { ComponentType, JSX } from 'react';
import { BanIcon, CircleCheckIcon, type SvgIconProps } from '../icons';

export function PendingStatusIcon({ pending, cancelled, icon }: {
  pending: boolean; cancelled: boolean; icon: ComponentType<SvgIconProps>;
}): JSX.Element {
  const Icon = pending ? icon : cancelled ? BanIcon : CircleCheckIcon;
  return <Icon className="mr-1 inline h-3 w-3 align-text-bottom" />;
}
