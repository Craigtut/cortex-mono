// Run each package's suite under that package's own vitest config.
//
// Without this file, a root `vitest run` discovers every `*.test.ts` in the
// repo and applies vitest defaults to all of them, silently ignoring the
// per-package vitest configs. That is how the cortex-code suite came to run
// in CI without the alias that points it at framework source, testing a
// `packages/cortex/dist` that nothing had rebuilt.
//
// Packages without a config of their own fall back to the defaults, which is
// what they were getting anyway.
export default ['packages/*'];
