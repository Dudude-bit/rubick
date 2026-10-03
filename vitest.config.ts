import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/ui"),
    },
  },
  test: {
    setupFiles: ["./src/ui/test-setup.ts"],
    exclude: ["node_modules", "dist", "src/tauri", "src/website"],
    // `.test.ts` under node unless it says `// @vitest-environment jsdom`.
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/ui/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/ui/**/*.test.ts"],
        },
      },
    ],
  },
});
