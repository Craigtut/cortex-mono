import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The running Cortex Code version, read from package.json. */
export const PKG_VERSION: string = (require('../package.json') as { version: string }).version;

/** The published npm package name for Cortex Code. */
export const PKG_NAME = '@animus-labs/cortex-code';
