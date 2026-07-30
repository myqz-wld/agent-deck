import { describe, expect, it } from 'vitest';
import { toolStatusView } from './tool-status';

describe('toolStatusView', () => {
  it('renders synthesized terminal reconciliation as aborted, not unknown', () => {
    expect(toolStatusView({ status: 'aborted' })).toEqual({
      label: '已中止',
      detail: null,
      isError: false,
    });
  });
});
