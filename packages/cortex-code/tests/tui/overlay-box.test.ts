import { afterEach, describe, expect, it } from 'vitest';
import { TuiMainScreen, type TUI, Container, SelectList, type Component } from '@earendil-works/pi-tui';
import { OverlayBox } from '../../src/tui/overlay-box.js';

// Permissive SelectList theme: identity styling so a deferred render never throws.
const selectTheme = new Proxy({}, { get: () => (s = '') => s }) as never;

// Minimal focusable child that records the input it receives.
function recordingChild(sink: string[]): Component {
  return { focused: false, render: () => [], invalidate: () => {}, handleInput: (d: string) => sink.push(d) };
}

describe('OverlayBox input routing', () => {
  it('routes input to the active child rather than the inner container', () => {
    const box = new OverlayBox(new Container(), 'Add a provider');
    const received: string[] = [];
    box.setActiveChild(recordingChild(received));

    box.handleInput('a');

    expect(received).toEqual(['a']);
  });

  it('does not throw when no active child is set (inner Container has no handleInput)', () => {
    const box = new OverlayBox(new Container());
    expect(() => box.handleInput('x')).not.toThrow();
  });

  it('redirects input to the new child after the active child changes', () => {
    const box = new OverlayBox(new Container());
    const first: string[] = [];
    const second: string[] = [];
    box.setActiveChild(recordingChild(first));
    box.handleInput('1');
    box.setActiveChild(recordingChild(second));
    box.handleInput('2');

    expect(first).toEqual(['1']);
    expect(second).toEqual(['2']);
  });
});

describe('overlay focus survives a multi-step flow (real pi-tui focus-restore)', () => {
  let tui: TUI | undefined;

  afterEach(() => {
    tui?.stop();
    tui = undefined;
  });

  // pi-tui renamed the TUI-level input entry point (handleInput ->
  // handleTerminalInput) and keeps it private; this test drives it directly.
  function sendInput(t: TUI, data: string): void {
    (t as unknown as { handleTerminalInput(d: string): void }).handleTerminalInput(data);
  }

  function makeTui(): TUI {
    const terminal = {
      columns: 120,
      rows: 40,
      start() {},
      stop() {},
      write() {},
      hideCursor() {},
      showCursor() {},
    };
    return new TuiMainScreen(terminal as never);
  }

  // Reproduce the /login two-step flow inside an overlay:
  // tier-selection -> clear() -> provider-selection, then Enter on the 2nd list.
  // Returns the value onSelect fired with, or null if input never reached it.
  function runTwoStepFlow(focusInner: (box: OverlayBox, child: SelectList) => void): string | null {
    tui = makeTui();
    const base = new Container();
    tui.addChild(base);
    tui.setFocus(base);

    const inner = new Container();
    const box = new OverlayBox(inner, 'Add a provider');
    tui.showOverlay(box, { anchor: 'center', width: '70%', maxHeight: '80%' });

    // Step 1: tier-selection.
    const tierList = new SelectList([{ value: 'oauth', label: 'OAuth' }], 1, selectTheme);
    inner.addChild(tierList);
    focusInner(box, tierList);
    sendInput(tui, '\x1b[B'); // navigate within the first list

    // Step 2: provider-selection (clear + a fresh list, as SetupRenderer does).
    inner.clear();
    const providerList = new SelectList(
      [{ value: 'anthropic', label: 'Anthropic' }, { value: 'openai', label: 'OpenAI' }],
      2,
      selectTheme,
    );
    inner.addChild(providerList);
    focusInner(box, providerList);

    let selected: string | null = null;
    providerList.onSelect = (item) => { selected = item.value as string; };
    sendInput(tui, '\r'); // Enter on the highlighted item (Anthropic)
    return selected;
  }

  it('keeps focus on the OverlayBox and delivers input to the second-step list', () => {
    // The fix: focus the overlay component and route input through it.
    const selected = runTwoStepFlow((box, child) => {
      box.setActiveChild(child);
      tui!.setFocus(box);
    });

    expect(selected).toBe('anthropic');
  });

  it('drops input when inner children are focused directly (the regression this guards)', () => {
    // Focusing a detached overlay child (the pre-fix behavior) gets redirected
    // back to the OverlayBox by pi-tui's focus-restore, so the Enter never
    // reaches the SelectList and onSelect never fires.
    const selected = runTwoStepFlow((_box, child) => {
      tui!.setFocus(child);
    });

    expect(selected).toBeNull();
  });
});
