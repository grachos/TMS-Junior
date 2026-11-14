import { defineConfig } from 'vitest/config';

// With TEST_DB=1 several test files share one real test database (and the
// company's consecutivo counters), so they must not run at the same time.
export default defineConfig({
  test: { fileParallelism: process.env.TEST_DB !== '1' },
});
