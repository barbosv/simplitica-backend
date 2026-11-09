import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "dist-worker/**", "node_modules/**", ".wrangler/**", ".superpowers/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/worker.ts", "src/worker/**/*.ts", "test/worker/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: false, project: "./tsconfig.worker.json" },
    },
  },
);
