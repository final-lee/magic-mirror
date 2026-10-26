import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // agent worktrees under .claude/ are full repo copies; never collect their tests
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
