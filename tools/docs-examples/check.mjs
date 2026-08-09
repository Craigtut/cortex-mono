#!/usr/bin/env node
/**
 * Typecheck the TypeScript examples in the consumer guide against real source.
 *
 * Reads the fenced blocks out of the markdown at run time and compiles them.
 * The document is the artifact under test; this file holds no copy of it.
 * See README.md for the opt-out and the preamble rules.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
/**
 * Defaults to the consumer guide. The optional argument exists so the guards
 * below can be exercised against fixtures, and is the seam for checking a
 * second document later.
 */
const DOC = resolve(REPO, process.argv[2] ?? 'docs/cortex/consumer-guide.md');
const OUT_DIR = resolve(HERE, '.generated');
const OUT_FILE = resolve(OUT_DIR, 'examples.ts');

/** Fenced blocks whose first info-string word is exactly this. */
const LANGUAGE = 'typescript';

function fail(message) {
  console.error(`docs-examples: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

/**
 * Fenced blocks with their 1-based opening line, so a tsc diagnostic can be
 * mapped back to a line in the markdown rather than in the generated file.
 */
function extractBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let open = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^```(.*)$/.exec(line);
    if (!fence) continue;

    if (open) {
      // Only a bare ``` closes a block; an info string means a new fence.
      if (fence[1].trim() === '') {
        blocks.push({ ...open, body: lines.slice(open.startLine, i).join('\n') });
        open = null;
      }
      continue;
    }

    const info = fence[1].trim();
    if (info === '') continue;
    const [language, ...rest] = info.split(/\s+/);
    if (language !== LANGUAGE) continue;
    open = { fenceLine: i + 1, startLine: i + 1, info: rest.join(' ') };
  }

  if (open) fail(`unterminated \`\`\`${LANGUAGE} block opened at line ${open.fenceLine}`);
  return blocks;
}

/** `skip="reason"` in the info string, with the reason required. */
function readSkip(block) {
  if (!/\bskip\b/.test(block.info)) return null;
  const withReason = /\bskip="([^"]*)"/.exec(block.info);
  if (!withReason || withReason[1].trim() === '') {
    fail(
      `block at ${DOC}:${block.fenceLine} opts out with no reason. ` +
      'Write skip="why this block is not compilable".',
    );
  }
  return withReason[1];
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

/**
 * Pull import statements out of a block body. They cannot live inside the
 * function wrapper, and several blocks import overlapping names from the same
 * module, so they are merged into one import per module below.
 */
function hoistImports(body, block) {
  const kept = [];
  const imports = [];
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*import\b/.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    // Accumulate until the statement terminates, so a multi-line import is
    // taken whole rather than half-hoisted.
    let statement = lines[i];
    while (!/;\s*$/.test(statement.trim()) && i + 1 < lines.length) {
      i += 1;
      statement += `\n${lines[i]}`;
    }
    imports.push({ statement, line: block.fenceLine });
  }

  return { body: kept.join('\n'), imports };
}

/**
 * Merge hoisted imports into one statement per module, deduping names. An
 * unrecognised import form is an error rather than a silent drop: dropping it
 * would let the block compile against bindings it never declared.
 */
function mergeImports(imports) {
  const byModule = new Map();

  for (const { statement, line } of imports) {
    const parsed = /^\s*import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/s.exec(
      statement,
    );
    if (!parsed) {
      fail(
        `unsupported import form in the block at ${DOC}:${line}:\n  ${statement.trim()}\n` +
        'The merger handles named imports only. Extend it rather than dropping the import.',
      );
    }
    const [, typeOnly, names, module] = parsed;
    const set = byModule.get(module) ?? new Set();
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (name === '') continue;
      // `import type { X }` and `import { type X }` mean the same thing here;
      // normalise to the inline form so both dedupe against each other.
      set.add(typeOnly && !name.startsWith('type ') ? `type ${name}` : name);
    }
    byModule.set(module, set);
  }

  return [...byModule.entries()].map(([module, names]) => {
    const sorted = [...names].sort((a, b) =>
      a.replace(/^type /, '').localeCompare(b.replace(/^type /, '')),
    );
    return `import { ${sorted.join(', ')} } from '${module}';`;
  });
}

/** Every binding the preamble offers, so blocks can reference app-side names. */
function preambleNames() {
  const source = readFileSync(resolve(HERE, 'preamble.ts'), 'utf8');
  const names = [...source.matchAll(/^export declare (?:const|function)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]);
  if (names.length === 0) fail('preamble.ts declares nothing; it should declare the app-side stubs');
  return names;
}

function build(blocks) {
  const checked = [];
  const skipped = [];
  const allImports = [];

  for (const block of blocks) {
    const reason = readSkip(block);
    if (reason !== null) {
      skipped.push({ line: block.fenceLine, reason });
      continue;
    }
    const { body, imports } = hoistImports(block.body, block);
    if (body.trim() === '') {
      fail(
        `the block at ${DOC}:${block.fenceLine} has no statements once imports are hoisted. ` +
        'Give it content or opt it out with skip="reason".',
      );
    }
    allImports.push(...imports);
    checked.push({ line: block.fenceLine, body });
  }

  if (checked.length === 0) {
    fail(
      `no checked \`\`\`${LANGUAGE} blocks found in ${DOC}. ` +
      'The doc moved, was renamed, changed fence style, or every block is skipped.',
    );
  }

  const names = preambleNames();
  const parts = [
    '// GENERATED by tools/docs-examples/check.mjs. Do not edit.',
    `// Source of every example below: ${DOC}`,
    '/* eslint-disable */',
    ...mergeImports(allImports),
    `import { ${names.join(', ')} } from '../preamble.js';`,
    '',
    // The preamble bindings a given block does not use are unused imports;
    // this keeps the file honest under noUnusedLocals if it is ever enabled.
    `void [${names.join(', ')}];`,
    '',
  ];

  for (const { line, body } of checked) {
    parts.push(
      `// ${DOC}:${line}`,
      `export async function example_line_${line}(): Promise<void> {`,
      body,
      '}',
      '',
    );
  }

  return { source: parts.join('\n'), checked, skipped };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const markdown = (() => {
  try {
    return readFileSync(DOC, 'utf8');
  } catch {
    return fail(`cannot read ${DOC}. If the guide moved, update DOC in this script.`);
  }
})();

const blocks = extractBlocks(markdown);
if (blocks.length === 0) {
  fail(`no \`\`\`${LANGUAGE} blocks found in ${DOC}; refusing to pass over zero inputs`);
}

const { source, checked, skipped } = build(blocks);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, source, 'utf8');

const tsc = spawnSync(
  process.execPath,
  [resolve(REPO, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', resolve(HERE, 'tsconfig.json')],
  { cwd: REPO, encoding: 'utf8' },
);

const output = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.trim();

// Diagnostics inside packages/ are the library's own, not the examples'. This
// harness does not own them (`npm run typecheck` does), and failing on them
// would make the examples un-checkable whenever the tree is mid-edit. They are
// still reported, because they make example diagnostics unreliable.
const lines = output.split('\n').filter((line) => line.trim() !== '');
const libraryErrors = lines.filter((line) => line.startsWith('packages/'));
const exampleErrors = lines.filter(
  (line) => !line.startsWith('packages/') && /error TS\d+/.test(line),
);

for (const { line, reason } of skipped) {
  console.log(`skipped ${DOC}:${line} (${reason})`);
}

if (libraryErrors.length > 0) {
  console.warn(
    `\ndocs-examples: NOTE, the library itself has ${libraryErrors.length} typecheck ` +
    'diagnostic(s). They are not example failures and are not this check\'s to fix, ' +
    'but example diagnostics may be cascades of them. Run npm run typecheck.\n' +
    libraryErrors.map((line) => `  ${line}`).join('\n'),
  );
}

if (exampleErrors.length > 0) {
  console.error(`\n${output}`);
  console.error(
    `\ndocs-examples: ${checked.length} example(s) checked, ${skipped.length} skipped. FAILED.\n` +
    `Diagnostics point into ${OUT_FILE}; each example there is preceded by its ` +
    'source line in the guide.',
  );
  process.exit(1);
}

// A non-zero tsc exit with nothing attributable to the examples means the
// compiler itself failed (bad config, missing types), which must not read as a
// pass.
if (tsc.status !== 0 && libraryErrors.length === 0) {
  console.error(output || `tsc exited ${tsc.status} with no diagnostics`);
  process.exit(1);
}

console.log(`docs-examples: ${checked.length} example(s) checked, ${skipped.length} skipped. OK.`);
