import { defineConfig } from 'vitest/config';
import base from '../../../../vitest.config';
export default defineConfig({ ...base, test: { ...base.test, include: ['ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence/catalog.test.ts'] } });
