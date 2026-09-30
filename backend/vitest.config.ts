import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/tmp/**", "**/dist/**"],
    testTimeout: 15000,
    // Global setup: mocks BullMQ/Redis before any test module is loaded.
    // This prevents live TCP connections to Redis during unit tests.
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
