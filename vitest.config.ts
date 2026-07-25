import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000, // unit tests are fast; integration tests set their own longer timeouts inline
    hookTimeout: 20_000,
  },
});
