import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@earendil-works/pi-tui', () => {
  class MockEditor {
    private _text = '';
    constructor(_tui: unknown, _theme: unknown) {}
    getText(): string { return this._text; }
    setText(t: string): void { this._text = t; }
    setAutocompleteProvider(_p: unknown): void {}
    isShowingAutocomplete(): boolean { return false; }
    handleInput(_data: string): void {}
  }

  return {
    Editor: MockEditor,
    CombinedAutocompleteProvider: class { constructor(..._a: unknown[]) {} },
    matchesKey: (data: string, token: string) => data === token,
    Key: {
      ctrl: (c: string) => `ctrl+${c}`,
      ctrlShift: (c: string) => `ctrlShift+${c}`,
      escape: 'escape',
    },
  };
});

vi.mock('../../src/tui/command-provider.js', () => ({
  buildSlashCommands: () => [],
}));

import { CustomEditor, type CustomEditorCallbacks } from '../../src/tui/editor.js';

const CTRL_C = 'ctrl+c';

function makeEditor() {
  const callbacks: CustomEditorCallbacks = {
    onSubmit: vi.fn(),
    onAbort: vi.fn(),
    onExit: vi.fn(),
    onExitHint: vi.fn(),
    onToggleExpand: vi.fn(),
    onToggleExpandAll: vi.fn(),
  };
  const editor = new CustomEditor({} as never, {} as never, callbacks, '/tmp');
  return { editor, callbacks };
}

describe('CustomEditor Ctrl+C handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clearing text with Ctrl+C does not arm the exit window', () => {
    const { editor, callbacks } = makeEditor();
    editor.setText('some draft');

    // First Ctrl+C just clears the text; no hint shown, timer not armed.
    editor.handleInput(CTRL_C);
    expect(editor.getText()).toBe('');
    expect(callbacks.onExit).not.toHaveBeenCalled();
    expect(callbacks.onAbort).not.toHaveBeenCalled();
    expect(callbacks.onExitHint).not.toHaveBeenCalled();

    // Immediate second Ctrl+C on the now-empty editor must NOT exit; it shows
    // the hint and arms the window instead.
    editor.handleInput(CTRL_C);
    expect(callbacks.onExit).not.toHaveBeenCalled();
    expect(callbacks.onAbort).toHaveBeenCalledTimes(1);
    expect(callbacks.onExitHint).toHaveBeenCalledTimes(1);
  });

  it('double Ctrl+C on an empty editor exits', () => {
    const { editor, callbacks } = makeEditor();

    editor.handleInput(CTRL_C); // abort + hint, arm the window
    expect(callbacks.onExitHint).toHaveBeenCalledTimes(1);
    expect(callbacks.onExit).not.toHaveBeenCalled();

    editor.handleInput(CTRL_C); // within 500ms -> exit
    expect(callbacks.onExit).toHaveBeenCalledTimes(1);
  });
});
