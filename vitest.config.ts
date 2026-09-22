import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    setupFiles: ["./src/test-setup.ts"],
    exclude: ["node_modules", "dist", "src-tauri"],
    // The extension picks the environment. A jsdom per file was half of the
    // suite's time, and most `.test.ts` files never touch a DOM; one that
    // does says so on its first line with `// @vitest-environment jsdom`.
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
    ],
  },
});
