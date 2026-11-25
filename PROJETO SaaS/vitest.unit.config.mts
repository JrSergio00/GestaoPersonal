import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/auth.test.ts',
      'tests/supabase-rest.test.ts',
      'tests/student-payments.test.ts',
      'tests/dashboard-finance.test.ts',
      'tests/workouts.test.ts',
    ],
  },
});
