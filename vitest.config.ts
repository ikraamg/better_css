import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Never attach to a developer's Chrome on 9222 during tests: the lifecycle/orphan
    // tests assert on csstruth's OWN launched Chrome, and attaching would also open test
    // tabs in the user's visible browser. Subprocess-spawned CLIs inherit this env.
    env: { CSSTRUTH_NO_ATTACH: '1' },
  },
})
