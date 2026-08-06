import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get: getSession } }));

import { desktopClaudeCwdTransitionHost } from './cwd-transition-controller-host';

describe('desktopClaudeCwdTransitionHost', () => {
  beforeEach(() => getSession.mockReset());

  it('reads the authoritative session repository', () => {
    const record = { id: 'session-a' };
    getSession.mockReturnValue(record);
    expect(desktopClaudeCwdTransitionHost.getSession('session-a')).toBe(record);
    expect(getSession).toHaveBeenCalledWith('session-a');
  });
});
