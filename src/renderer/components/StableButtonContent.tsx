import type { JSX, ReactNode } from 'react';

export interface StableButtonVariant {
  key: string;
  content: ReactNode;
}

interface Props {
  activeKey: string;
  variants: readonly StableButtonVariant[];
}

/**
 * Overlay every button-content variant in one intrinsic grid.
 *
 * Hidden variants still size the grid, so changing status text or an icon never resizes the
 * surrounding button. Only the active variant remains exposed to assistive technology.
 */
export function StableButtonContent({ activeKey, variants }: Props): JSX.Element {
  const resolvedActiveKey = variants.some((variant) => variant.key === activeKey)
    ? activeKey
    : variants[0]?.key;

  return (
    <span className="inline-grid place-items-center">
      {variants.map((variant) => {
        const active = variant.key === resolvedActiveKey;
        return (
          <span
            key={variant.key}
            aria-hidden={active ? undefined : true}
            data-stable-button-variant={variant.key}
            className={`${active ? '' : 'invisible'} col-start-1 row-start-1 inline-flex items-center justify-self-center whitespace-nowrap`}
          >
            {variant.content}
          </span>
        );
      })}
    </span>
  );
}
