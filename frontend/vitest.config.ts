import { defineConfig } from 'vitest/config'

// Only the pure functions in lib/ are covered. They are the ones that decide
// what the operator is told — whether the agent is pitching, whether a call is
// still live, whether the Call button is disabled — and they need no DOM.
export default defineConfig({
  // No globals: the test file imports `it`/`expect` from vitest so that
  // `npx tsc --noEmit` and `next build` typecheck it without extra type config.
  test: { environment: 'node', include: ['lib/**/*.test.ts'] },
})
