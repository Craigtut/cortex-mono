/**
 * API-key entry must actually read what the user typed.
 *
 * SetupRenderer overrides Input.handleInput and, on Enter, reads the typed
 * text back off the component. pi-tui's Input keeps that text in a private
 * `value` behind getValue(); it has no `text` field and never has. Reading
 * `.text` through a cast therefore yielded undefined on every keystroke path,
 * so `if (text)` never fired and Enter did nothing: API-key entry, custom
 * base-URL entry and custom model-id entry could not be completed at all.
 *
 * The cast is what hid it. `(input as unknown as { text: string })` asserts a
 * field into existence, so neither the compiler nor a Cortex-authored Input
 * double can object. The sibling render test mocks pi-tui wholesale and stubs
 * matchesKey to false, so its Enter path is never exercised either.
 *
 * This test therefore uses the REAL pi-tui Input and the REAL Enter key, and
 * asserts on the value that reaches the flow. Against the `.text` build it
 * fails at the final assertion with validateApiKey never called.
 */
import { describe, it, expect, vi } from 'vitest';
import { TuiMainScreen, type TUI, Input, SelectList } from '@earendil-works/pi-tui';

vi.mock('../../src/providers/ollama.js', () => ({
  detectOllama: async () => ({ running: false, models: [] }),
  getOllamaContextWindow: async () => undefined,
  getOllamaHost: () => 'http://localhost:11434',
}));

vi.mock('../../src/logger.js', () => ({
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { runSetupInOverlay } = await import('../../src/providers/setup-tui.js');

/** A terminal stub with the surface pi-tui touches during a headless render. */
function stubTerminal(): never {
  return {
    columns: 120,
    rows: 40,
    start() {},
    stop() {},
    write() {},
    hideCursor() {},
    showCursor() {},
  } as never;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * Depth-first search of the live component tree for the LAST match.
 *
 * Setup renders into an overlay, so the tree runs through pi-tui's
 * overlayStack entries as well as plain `children`. Last-match because each
 * step appends to the same container and we always want the current step.
 */
function findComponents<T>(root: unknown, match: (node: unknown) => boolean): T[] {
  const seen = new Set<unknown>();
  const found: T[] = [];
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (match(node)) found.push(node as T);
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) children.forEach(walk);
    const overlays = (node as { overlayStack?: unknown }).overlayStack;
    if (Array.isArray(overlays)) {
      for (const entry of overlays) walk((entry as { component?: unknown })?.component);
    }
    // OverlayBox holds its content as a private `innerComponent`.
    const inner = (node as { innerComponent?: unknown }).innerComponent;
    if (inner) walk(inner);
  };
  walk(root);
  return found;
}

function findLast<T>(root: unknown, match: (node: unknown) => boolean): T | null {
  const all = findComponents<T>(root, match);
  return all.length > 0 ? all[all.length - 1]! : null;
}

function selectByValue(list: SelectList, value: string): void {
  const items = (list as unknown as { items: Array<{ value: string }> }).items;
  const item = items.find(i => i.value === value);
  if (!item) throw new Error(`no "${value}" in [${items.map(i => i.value).join(', ')}]`);
  (list as unknown as { onSelect?: (i: unknown) => void }).onSelect?.(item);
}

describe('provider setup API-key entry (real pi-tui Input)', () => {
  it('submits the typed key on Enter', async () => {
    const tui: TUI = new TuiMainScreen(stubTerminal());
    const providerManager = {
      // Resolving 'invalid' keeps the flow from advancing past validation into
      // model listing; the assertion here is about what validateApiKey RECEIVES.
      validateApiKey: vi.fn(async () => ({ status: 'invalid' as const })),
      listModels: vi.fn(async () => []),
    };
    const credentialStore = { setProvider: vi.fn(async () => {}), setDefaults: vi.fn(async () => {}) };

    void runSetupInOverlay(tui as never, providerManager as never, credentialStore as never);
    await settle();

    const tierList = findLast<SelectList>(tui, n => n instanceof SelectList);
    expect(tierList).not.toBeNull();
    selectByValue(tierList!, 'api_key');
    await settle();

    const providerList = findLast<SelectList>(tui, n => n instanceof SelectList);
    expect(providerList).not.toBeNull();
    selectByValue(providerList!, 'anthropic');
    await settle();

    const input = findLast<Input>(tui, n => n instanceof Input);
    expect(input).not.toBeNull();

    // Type through the renderer's own override, which delegates to pi-tui for
    // non-Enter keys — the same path a real keystroke takes.
    const key = 'sk-ant-typed-by-user';
    for (const ch of key) input!.handleInput(ch);
    expect(input!.getValue()).toBe(key);

    input!.handleInput('\r');
    await settle();

    expect(providerManager.validateApiKey).toHaveBeenCalledWith('anthropic', key);
  });
});
