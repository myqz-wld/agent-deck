import type { JSX, SVGProps } from 'react';

export interface SvgIconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'strokeWidth'> {
  /** Visible size in CSS pixels. A className may override it. */
  size?: number;
  /** Supply only when the SVG itself carries meaning; icon buttons label the button instead. */
  label?: string;
  strokeWidth?: number;
}

export interface SvgIconBaseProps extends SvgIconProps {
  children: React.ReactNode;
  fill?: string;
  strokeWidth?: number;
  viewBox?: string;
}

/** Shared renderer chrome primitive: source-owned, currentColor, and non-focusable by default. */
export function SvgIcon({
  children,
  size = 16,
  label,
  fill = 'none',
  strokeWidth = 1.8,
  viewBox = '0 0 24 24',
  ...props
}: SvgIconBaseProps): JSX.Element {
  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      {...props}
    >
      {label ? <title>{label}</title> : null}
      {children}
    </svg>
  );
}
