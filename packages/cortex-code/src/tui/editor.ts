import { Editor, type TUI, type EditorTheme, CombinedAutocompleteProvider, matchesKey, Key } from '@mariozechner/pi-tui';
import type { PermissionPromptComponent } from './permissions.js';
import { buildSlashCommands } from './command-provider.js';

export interface CustomEditorCallbacks {
  onSubmit: (text: string) => void;
  onAbort: () => void;
  onExit: () => void;
  onExitHint: () => void;
  onToggleExpand: () => void;
  onToggleExpandAll: () => void;
  onInputActivity?: (kind: string) => void;
}

/**
 * Custom editor extending pi-tui's Editor with:
 * - Input interception for inline permission prompts
 * - Ctrl+C handling (single: clear, double: exit)
 * - Escape to abort
 * - Ctrl+E to toggle tool expand/collapse
 */
export class CustomEditor extends Editor {
  /** The currently active inline permission prompt, if any. */
  activePermissionPrompt: PermissionPromptComponent | null = null;

  private callbacks: CustomEditorCallbacks;
  private lastCtrlCTime = 0;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    callbacks: CustomEditorCallbacks,
    cwd: string,
  ) {
    super(tui, theme);
    this.callbacks = callbacks;

    // Set up autocomplete with slash commands
    const slashCommands = buildSlashCommands();
    const autocomplete = new CombinedAutocompleteProvider(slashCommands, cwd);
    this.setAutocompleteProvider(autocomplete);

    // Set up submit handler
    this.onSubmit = (text: string) => {
      if (!text.trim()) return;
      this.addToHistory(text);
      this.callbacks.onSubmit(text);
    };
  }

  /** Refresh autocomplete commands (e.g., when skills are discovered). */
  refreshCommands(cwd: string): void {
    const slashCommands = buildSlashCommands();
    const autocomplete = new CombinedAutocompleteProvider(slashCommands, cwd);
    this.setAutocompleteProvider(autocomplete);
  }

  override handleInput(data: string): void {
    // Route to permission prompt if active
    if (this.activePermissionPrompt) {
      this.callbacks.onInputActivity?.('permission');
      this.activePermissionPrompt.handleInput(data);
      return;
    }

    // Ctrl+C: clear editor or exit
    if (matchesKey(data, Key.ctrl('c'))) {
      this.callbacks.onInputActivity?.('ctrl-c');
      const now = Date.now();
      if (now - this.lastCtrlCTime < 500) {
        this.callbacks.onExit();
        return;
      }
      this.lastCtrlCTime = now;

      // If editor has text, clear it; otherwise abort and show exit hint
      if (this.getText().trim()) {
        this.setText('');
      } else {
        this.callbacks.onAbort();
        this.callbacks.onExitHint();
      }
      return;
    }

    // Escape: abort current operation
    if (matchesKey(data, Key.escape)) {
      this.callbacks.onInputActivity?.('escape');
      // Don't intercept if autocomplete is showing (let Editor handle it)
      if (!this.isShowingAutocomplete()) {
        this.callbacks.onAbort();
        return;
      }
    }

    // Ctrl+Shift+E: toggle all tool results expansion
    if (matchesKey(data, Key.ctrlShift('e'))) {
      this.callbacks.onInputActivity?.('toggle-expand-all');
      this.callbacks.onToggleExpandAll();
      return;
    }

    // Ctrl+E: toggle most recent tool result expansion
    if (matchesKey(data, Key.ctrl('e'))) {
      this.callbacks.onInputActivity?.('toggle-expand');
      this.callbacks.onToggleExpand();
      return;
    }

    // Default: pass to pi-tui Editor
    this.callbacks.onInputActivity?.('text');
    super.handleInput(data);
  }
}
