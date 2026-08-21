import type { JSX, ReactNode } from 'react';

/** Block user interaction without changing the settled visual presentation of child controls. */
export function InertInteractionBoundary({
  blocked,
  children,
}: {
  blocked: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div inert={blocked || undefined} aria-disabled={blocked || undefined}>
      {children}
    </div>
  );
}
