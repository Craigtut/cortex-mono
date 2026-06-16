import { defineConfig } from 'tsup';

// cortex-code is a CLI application, not a library. We bundle the internal,
// unpublished workspace package (@animus-labs/brand) directly into the shipped
// artifact so end users never need to resolve it from npm. Every other import
// is a real npm dependency that must stay external and be installed normally.
//
// The `external` regex matches any bare specifier (anything not starting with
// "."), so every node_modules package and node: builtin is externalized.
// Relative imports (cortex-code's own source) are bundled. `noExternal` takes
// precedence in tsup, so brand is the single exception that gets inlined. This
// also acts as a safety net: an undeclared/phantom import can never silently
// pull a heavy dependency tree into the shipped artifact.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  external: [/^[^.]/],
  noExternal: ['@animus-labs/brand'],
  sourcemap: true,
  splitting: false,
  clean: true,
  esbuildOptions(options) {
    // Resolve @animus-labs/brand from its TypeScript source so it bundles
    // without needing a prior build step.
    options.conditions = ['source', 'import', 'default'];
  },
});
