import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // .claude/worktrees holds agent worktrees with their own copies of the tests.
    exclude: [...configDefaults.exclude, ".claude/**", "dist/**"],
  },
});
