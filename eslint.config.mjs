import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores
  {
    ignores: ["**/node_modules/", "**/dist/", "**/build/", "**/*.js", "**/*.mjs", "**/*.cjs"],
  },

  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript recommended rules (type-aware not enabled to keep it fast)
  ...tseslint.configs.recommended,

  // Project-wide settings
  {
    files: ["packages/*/src/**/*.ts"],
    rules: {
      // Relax rules that would produce many violations on existing code
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/ban-ts-comment": "warn",

      // Regex rules: disabled because the codebase uses intentional control
      // characters and unicode ranges in security-related regex patterns
      "no-control-regex": "off",
      "no-misleading-character-class": "off",

      // Standard relaxations for practical TypeScript
      "no-constant-condition": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
    },
  },

  // Test files get additional relaxations
  {
    files: ["packages/*/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-empty-function": "off",
      "no-empty": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  }
);
