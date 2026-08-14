import { describe, expect, it } from 'vitest';
import {
  REMOTE_OWNER_PRODUCT_V1_METHODS,
  UNGRANTED_REMOTE_CORE_METHODS,
} from '@contracts/index';
import { REMOTE_DESKTOP_PRODUCT_METHODS } from './product-method-directory';

describe('Remote Desktop product method directory', () => {
  it('is exactly the Remote Owner Product v1 grant shared with Feishu', () => {
    expect([...REMOTE_DESKTOP_PRODUCT_METHODS].sort()).toEqual(
      [...REMOTE_OWNER_PRODUCT_V1_METHODS].sort(),
    );
    for (const denied of UNGRANTED_REMOTE_CORE_METHODS) {
      expect(REMOTE_DESKTOP_PRODUCT_METHODS).not.toContain(denied);
    }
  });
});
