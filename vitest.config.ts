import { defineConfig } from "vitest/config";

// Standalone test config — deliberately NO app plugins (iwsdkDev / pose relay /
// uikitml). The unit suite covers the pure-logic modules in a node environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
