import { describe, expect, it } from 'vitest';

import { requireLinuxInstanceId } from './validation';

describe('Linux instance labels', () => {
  it.each(['a', 'instance-a', 'a'.repeat(63)])('accepts %s', (value) => {
    expect(requireLinuxInstanceId(value)).toBe(value);
  });

  it.each([
    'Instance-a',
    '实例-a',
    'a'.repeat(64),
    '-instance',
    'instance-',
  ])('rejects non-exact instance label %s', (value) => {
    expect(() => requireLinuxInstanceId(value)).toThrow('lowercase Linux instance label');
  });
});
