import { defineConfig } from 'vitest/config';
import base from '../../../../vitest.config';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['ref/reviews/evidence/claude-input-loss/probe.test.ts'],
  },
});
