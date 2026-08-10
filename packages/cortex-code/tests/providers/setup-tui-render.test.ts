/**
 * The setup overlay must paint the step it advanced to.
 *
 * pi-tui repaints when a component asks it to. Mutating a Container does not
 * ask, and neither does setFocus, so the only thing driving frames during
 * provider setup is the Loader's animation interval. Every step of this flow
 * that lands from a promise (OAuth returning, a key validating, an endpoint
 * answering) stops that loader first and then rebuilds the container, which
 * means the flow can advance with nothing on screen changing: a completed
 * OAuth login sat under a frozen "Exchanging authorization code for tokens..."
 * with the model list live and focused one repaint away.
 *
 * These drive the real SetupRenderer through runSetupInOverlay and assert on
 * repaints requested after the loader stops, because that is the window where
 * the flow has no other way to reach the screen. Asserting only that the
 * container ends up holding a SelectList would pass on the frozen build.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeSelectList {
  items: Array<{ value: string; label: string }>;
  onSelect?: (item: { value: string; label: string }) => void;
  onCancel?: () => void;
}

interface FakeLoader {
  message: string;
  stopped: boolean;
  /** Repaint count at the moment stop() was called. */
  rendersAtStop: number | null;
}

const { renderCalls, selectLists, loaders, inputs } = vi.hoisted(() => ({
  renderCalls: { count: 0 },
  selectLists: [] as FakeSelectList[],
  loaders: [] as FakeLoader[],
  inputs: [] as unknown[],
}));

vi.mock('@earendil-works/pi-tui', () => {
  class MockContainer {
    children: unknown[] = [];
    addChild(child: unknown): void { this.children.push(child); }
    removeChild(child: unknown): void { this.children = this.children.filter(c => c !== child); }
    clear(): void { this.children = []; }
    invalidate(): void {}
    render(): string[] { return []; }
  }

  class MockTUI extends MockContainer {
    focused: unknown = null;
    requestRender(): void { renderCalls.count++; }
    setFocus(component: unknown): void { this.focused = component; }
    showOverlay(): { hide: () => void } { return { hide: () => {} }; }
    hideOverlay(): void {}
    addInputListener(): () => void { return () => {}; }
    start(): void {}
    stop(): void {}
  }

  class MockText {
    constructor(public text = '') {}
    setText(text: string): void { this.text = text; }
    render(): string[] { return []; }
    invalidate(): void {}
  }

  class MockSpacer {
    render(): string[] { return []; }
    invalidate(): void {}
  }

  class MockInput {
    text = '';
    constructor() { inputs.push(this); }
    handleInput(): void {}
    render(): string[] { return []; }
    invalidate(): void {}
  }

  class MockSelectList {
    onSelect?: (item: unknown) => void;
    onCancel?: () => void;
    constructor(public items: Array<{ value: string; label: string }>) {
      selectLists.push(this as unknown as FakeSelectList);
    }
    handleInput(): void {}
    render(): string[] { return []; }
    invalidate(): void {}
  }

  // Mirrors the real Loader's contract in the one way that matters here: it is
  // the component that drives repaints, and stop() ends that.
  class MockLoader {
    stopped = false;
    rendersAtStop: number | null = null;
    constructor(
      private ui: { requestRender: () => void },
      _spinner: unknown,
      _muted: unknown,
      public message = 'Loading...',
    ) {
      loaders.push(this as unknown as FakeLoader);
      ui.requestRender();
    }
    setMessage(message: string): void {
      this.message = message;
      if (!this.stopped) this.ui.requestRender();
    }
    stop(): void {
      this.stopped = true;
      this.rendersAtStop = renderCalls.count;
    }
    render(): string[] { return []; }
    invalidate(): void {}
  }

  return {
    TUI: MockTUI,
    ProcessTerminal: class {},
    Container: MockContainer,
    Text: MockText,
    Spacer: MockSpacer,
    SelectList: MockSelectList,
    Input: MockInput,
    Loader: MockLoader,
    Box: class {},
    matchesKey: () => false,
    Key: { enter: 'enter', escape: 'escape', ctrl: (c: string) => `ctrl+${c}` },
    visibleWidth: (s: string) => s.length,
  };
});

vi.mock('../../src/providers/ollama.js', () => ({
  detectOllama: async () => ({ running: false, models: [] }),
  getOllamaContextWindow: async () => undefined,
  getOllamaHost: () => 'http://localhost:11434',
}));

vi.mock('../../src/logger.js', () => ({
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { TUI } = await import('@earendil-works/pi-tui');
const { runSetupInOverlay } = await import('../../src/providers/setup-tui.js');

beforeEach(() => {
  renderCalls.count = 0;
  selectLists.length = 0;
  loaders.length = 0;
  inputs.length = 0;
});

/** Pick an option by value from the most recently rendered SelectList. */
function choose(list: FakeSelectList, value: string): void {
  const item = list.items.find(i => i.value === value);
  if (!item) throw new Error(`no "${value}" option in [${list.items.map(i => i.value).join(', ')}]`);
  list.onSelect!(item);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('provider setup overlay repaints', () => {
  it('paints the model list once OAuth resolves and the loader stops', async () => {
    const tui = new TUI({} as never);
    let finishOAuth!: (value: { credentials: string; meta: unknown }) => void;
    const providerManager = {
      initiateOAuth: vi.fn((_provider: string, callbacks: { onProgress?: (m: string) => void }) =>
        new Promise<{ credentials: string; meta: unknown }>(resolve => {
          finishOAuth = (value) => {
            // pi-ai's last word before the token exchange, and the message the
            // frozen build was still showing minutes later.
            callbacks.onProgress?.('Exchanging authorization code for tokens...');
            resolve(value);
          };
        }),
      ),
      listModels: vi.fn(async () => [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }]),
    };
    const credentialStore = { setProvider: vi.fn(async () => {}), setDefaults: vi.fn(async () => {}) };

    const done = runSetupInOverlay(tui as never, providerManager as never, credentialStore as never);
    await settle();

    choose(selectLists[0]!, 'oauth');
    choose(selectLists[1]!, 'anthropic');
    await settle();

    const loader = loaders.at(-1)!;
    expect(loader.message).toContain('browser');

    finishOAuth({ credentials: '{"access":"a"}', meta: {} });
    await settle();

    // The flow advanced: credentials stored, model list built.
    expect(credentialStore.setProvider).toHaveBeenCalled();
    expect(loader.stopped).toBe(true);
    const modelList = selectLists.at(-1)!;
    expect(modelList.items.map(i => i.value)).toEqual(['claude-opus-4-8']);

    // And the screen was told about it. Without this, everything above is true
    // while the terminal still shows the loader's final frame.
    expect(renderCalls.count).toBeGreaterThan(loader.rendersAtStop!);

    choose(modelList, 'claude-opus-4-8');
    await expect(done).resolves.toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('paints the failure when OAuth rejects', async () => {
    const tui = new TUI({} as never);
    let failOAuth!: (err: Error) => void;
    const providerManager = {
      initiateOAuth: vi.fn(() => new Promise((_resolve, reject) => { failOAuth = reject; })),
      listModels: vi.fn(async () => []),
    };
    const credentialStore = { setProvider: vi.fn(async () => {}), setDefaults: vi.fn(async () => {}) };

    void runSetupInOverlay(tui as never, providerManager as never, credentialStore as never);
    await settle();

    choose(selectLists[0]!, 'oauth');
    choose(selectLists[1]!, 'anthropic');
    await settle();

    const loader = loaders.at(-1)!;
    failOAuth(new Error('token exchange failed'));
    await settle();

    expect(loader.stopped).toBe(true);
    expect(renderCalls.count).toBeGreaterThan(loader.rendersAtStop!);
  });
});
