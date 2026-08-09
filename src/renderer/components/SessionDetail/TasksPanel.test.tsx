// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskRecordsView } from './TasksPanel';

afterEach(cleanup);

describe('TaskRecordsView', () => {
  it('shows an initial load error instead of a permanent loading state', () => {
    render(<TaskRecordsView tasks={[]} loaded={false} error="tasks unavailable" />);
    expect(screen.getByText('tasks unavailable')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});
