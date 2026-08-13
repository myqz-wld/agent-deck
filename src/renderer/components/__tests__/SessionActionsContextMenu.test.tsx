// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SessionActionsContextMenu,
  sessionContextMenuPosition,
} from '../SessionActionsContextMenu';

afterEach(cleanup);

describe('SessionActionsContextMenu', () => {
  it('keeps the pointer anchor when there is room', () => {
    expect(sessionContextMenuPosition(
      { x: 120, y: 80 },
      { height: 60, width: 128 },
      { height: 600, width: 800 },
    )).toEqual({ x: 120, y: 80 });
  });

  it('moves inward at the viewport edges', () => {
    expect(sessionContextMenuPosition(
      { x: 790, y: 590 },
      { height: 60, width: 128 },
      { height: 600, width: 800 },
    )).toEqual({ x: 664, y: 532 });
  });

  it('renders the action list in a body portal', () => {
    render(<SessionActionsContextMenu
      position={{ x: 120, y: 80 }}
      onClose={vi.fn()}
      actions={[{ icon: null, label: '归档', run: vi.fn() }]}
    />);
    expect(document.body.querySelector('[role="menu"]')).toBeTruthy();
  });
});
