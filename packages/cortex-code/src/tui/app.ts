import {
  TUI,
  ProcessTerminal,
  Container,
  Spacer,
  Text,
  Loader,
} from '@mariozechner/pi-tui';
import { CustomEditor, type CustomEditorCallbacks } from './editor.js';
import { StatusBar, type StatusBarState } from './status.js';
import { TranscriptManager } from './transcript.js';
import { PermissionPromptComponent, type PermissionResult } from './permissions.js';
import { editorTheme, colors } from './theme.js';

export interface AppCallbacks {
  /** Called when user submits a message or slash command. */
  onSubmit: (text: string) => void;
  /** Called when user requests abort (Escape or Ctrl+C with empty editor). */
  onAbort: () => void;
  /** Called when user double-presses Ctrl+C to exit. */
  onExit: () => void;
}

/**
 * Top-level TUI application.
 * Flat vertical stack: banner -> chat -> status -> editor -> footer.
 * Terminal native scrollback handles overflow.
 */
export class App {
  readonly tui: TUI;
  readonly terminal: ProcessTerminal;
  readonly chatContainer: Container;
  readonly statusContainer: Container;
  readonly editor: CustomEditor;
  readonly statusBar: StatusBar;
  readonly transcript: TranscriptManager;

  private statusLoader: Loader | null = null;

  constructor(callbacks: AppCallbacks, cwd: string) {
    this.terminal = new ProcessTerminal();
    this.tui = new TUI(this.terminal);

    // Build component tree
    this.chatContainer = new Container();
    this.statusContainer = new Container();
    this.statusBar = new StatusBar();

    const editorCallbacks: CustomEditorCallbacks = {
      onSubmit: callbacks.onSubmit,
      onAbort: callbacks.onAbort,
      onExit: callbacks.onExit,
      onExitHint: () => this.statusBar.showHint('Press Ctrl+C again to exit', 500),
      onToggleExpand: () => this.transcript.toggleGlobalExpand(),
    };
    this.editor = new CustomEditor(this.tui, editorTheme, editorCallbacks, cwd);

    // Assemble layout: flat vertical stack, terminal native scrollback
    this.tui.addChild(this.chatContainer);         // Messages, tool calls, prompts
    this.tui.addChild(this.statusContainer);        // Loading spinner
    this.tui.addChild(this.editor);                 // User input (has its own border)
    this.tui.addChild(this.statusBar);              // Footer

    // Set focus to editor
    this.tui.setFocus(this.editor);

    // Create transcript manager
    this.transcript = new TranscriptManager(this.chatContainer, this.tui);
  }

  /** Start the TUI event loop. */
  start(): void {
    this.tui.start();
  }

  /** Stop the TUI and clean up. */
  stop(): void {
    this.hideStatusSpinner();
    this.tui.stop();
  }

  /** Update the footer status bar. */
  updateStatus(state: Partial<StatusBarState>): void {
    this.statusBar.setState(state);
  }

  /** Show a loading spinner in the status area (during agent execution). */
  showStatusSpinner(message: string): void {
    this.hideStatusSpinner();
    this.statusLoader = new Loader(this.tui, colors.primary, colors.muted, message);
    this.statusContainer.addChild(this.statusLoader);
    this.statusLoader.start();
  }

  /** Hide the status spinner. */
  hideStatusSpinner(): void {
    if (this.statusLoader) {
      this.statusLoader.stop();
      this.statusContainer.removeChild(this.statusLoader);
      this.statusLoader = null;
    }
  }

  /**
   * Show an inline permission prompt and wait for the user's decision.
   * Only one prompt should be active at a time; the session layer
   * serializes concurrent requests and re-checks rules between them.
   */
  showPermissionPrompt(
    toolName: string,
    toolArgs: unknown,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const prompt = new PermissionPromptComponent(toolName, toolArgs, (result) => {
        this.transcript.removePermissionPrompt(prompt);
        this.editor.activePermissionPrompt = null;
        resolve(result);
      });

      this.transcript.addPermissionPrompt(prompt);
      this.editor.activePermissionPrompt = prompt;
    });
  }

  /** Re-focus the editor (e.g., after abort or permission prompt). */
  focusEditor(): void {
    this.tui.setFocus(this.editor);
  }

  /** Clear the editor text. */
  clearEditor(): void {
    this.editor.setText('');
  }

  /** Refresh slash command autocomplete (e.g., after skills discovered). */
  refreshCommands(cwd: string): void {
    this.editor.refreshCommands(cwd);
  }
}
