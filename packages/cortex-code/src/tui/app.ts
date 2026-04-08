import {
  TUI,
  ProcessTerminal,
  Container,
  Spacer,
} from '@mariozechner/pi-tui';
import { CustomEditor, type CustomEditorCallbacks } from './editor.js';
import { StatusBar, type StatusBarState } from './status.js';
import { TranscriptManager } from './transcript.js';
import { PermissionPromptComponent, type PermissionResult } from './permissions.js';
import { StatusSpinner } from './spinner.js';
import { editorTheme } from './theme.js';
import type { FreezeDiagnostics } from '../diagnostics/freeze.js';

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
  readonly activityContainer: Container;
  readonly statusContainer: Container;
  readonly editor: CustomEditor;
  readonly statusBar: StatusBar;
  readonly transcript: TranscriptManager;

  private statusIndicator: StatusSpinner | null = null;
  private statusSpacer: Spacer | null = null;
  private readonly cwd: string;
  private readonly diagnostics: FreezeDiagnostics | undefined;

  constructor(callbacks: AppCallbacks, cwd: string, diagnostics?: FreezeDiagnostics) {
    this.cwd = cwd;
    this.diagnostics = diagnostics;
    this.terminal = new ProcessTerminal();
    this.tui = new TUI(this.terminal);

    // Suppress cursor positioning globally. pi-tui's positionHardwareCursor()
    // moves the terminal cursor to the focused editor on every render cycle
    // (including 80ms Loader spinner ticks). This forces the terminal viewport
    // to the bottom, preventing scrolling. Since we don't use the hardware
    // cursor (showHardwareCursor defaults to false), we replace the method
    // with a no-op. The editor's visual cursor (fake cursor via styling)
    // still works because it's rendered as part of the component output.
    (this.tui as unknown as Record<string, unknown>)['positionHardwareCursor'] = () => {
      this.terminal.hideCursor();
    };
    this.patchRenderScheduler();

    // Build component tree
    this.chatContainer = new Container();
    this.activityContainer = new Container();
    this.statusContainer = new Container();
    this.statusBar = new StatusBar();

    const editorCallbacks: CustomEditorCallbacks = {
      onSubmit: callbacks.onSubmit,
      onAbort: callbacks.onAbort,
      onExit: callbacks.onExit,
      onExitHint: () => this.statusBar.showHint('Press Ctrl+C again to exit', 500),
      onToggleExpand: () => this.transcript.toggleExpand(),
      onToggleExpandAll: () => this.transcript.toggleExpandAll(),
      onInputActivity: (kind) => this.diagnostics?.recordKeypress(kind),
    };
    this.editor = new CustomEditor(this.tui, editorTheme, editorCallbacks, cwd);

    // Assemble layout: flat vertical stack, terminal native scrollback
    this.tui.addChild(this.chatContainer);         // Messages, tool calls, prompts
    this.tui.addChild(this.activityContainer);     // Compact "N subagents running" indicator
    this.tui.addChild(this.statusContainer);        // Loading spinner
    this.tui.addChild(this.editor);                 // User input (has its own border)
    this.tui.addChild(this.statusBar);              // Footer

    // Set focus to editor
    this.tui.setFocus(this.editor);

    // Create transcript manager
    this.transcript = new TranscriptManager(
      this.chatContainer,
      this.tui,
      this.activityContainer,
      this.diagnostics,
    );
  }

  /** Start the TUI event loop. */
  start(): void {
    this.diagnostics?.start();
    this.tui.start();
  }

  /** Stop the TUI and clean up. */
  stop(): void {
    this.transcript.clear();
    this.hideStatusSpinner();
    this.diagnostics?.stop();
    this.tui.stop();
  }

  /** Update the footer status bar. */
  updateStatus(state: Partial<StatusBarState>): void {
    this.statusBar.setState(state);
  }

  /** Show a loading spinner in the status area (during agent execution). */
  showStatusSpinner(message: string): void {
    this.hideStatusSpinner();
    // Breathing room above the spinner
    this.statusSpacer = new Spacer(1);
    this.statusContainer.addChild(this.statusSpacer);
    // Keep the top-level spinner low-frequency. Tool and subagent rows animate
    // through their own shared low-frequency ticker.
    this.statusIndicator = new StatusSpinner(this.tui, message);
    this.statusContainer.addChild(this.statusIndicator);
    this.tui.requestRender();
  }

  /** Hide the status spinner. */
  hideStatusSpinner(): void {
    this.removeWorkingTagSubtitle();
    if (this.statusSpacer) {
      this.statusContainer.removeChild(this.statusSpacer);
      this.statusSpacer = null;
    }
    if (this.statusIndicator) {
      this.statusIndicator.stop();
      this.statusContainer.removeChild(this.statusIndicator);
      this.statusIndicator = null;
      this.tui.requestRender();
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
      const prompt = new PermissionPromptComponent(toolName, toolArgs, this.cwd, (result) => {
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

  // ---------------------------------------------------------------------------
  // Working tag queue (rendered inline on the spinner line at reading pace)
  // ---------------------------------------------------------------------------

  /** Enqueue a completed working tag message for display at reading pace. */
  enqueueWorkingTagText(text: string): void {
    this.statusIndicator?.enqueueWorkingText(text);
  }

  /** Immediately clear the working tag queue and display. */
  removeWorkingTagSubtitle(): void {
    this.statusIndicator?.clearWorkingQueue();
  }

  /**
   * pi-tui schedules renders with process.nextTick(), which can starve stdin
   * under heavy repaint load. Yield with setImmediate() instead so Ctrl+C and
   * other input still get a chance to run between renders.
   */
  private patchRenderScheduler(): void {
    const tui = this.tui as unknown as Record<string, unknown>;
    const doRender = tui['doRender'];
    if (typeof doRender !== 'function') return;

    tui['requestRender'] = (force = false) => {
      this.diagnostics?.recordRenderRequested(force);
      if (force) {
        tui['previousLines'] = [];
        tui['previousWidth'] = -1;
        tui['previousHeight'] = -1;
        tui['cursorRow'] = 0;
        tui['hardwareCursorRow'] = 0;
        tui['maxLinesRendered'] = 0;
        tui['previousViewportTop'] = 0;
      }

      if (tui['renderRequested']) return;
      tui['renderRequested'] = true;

      setImmediate(() => {
        const startedAt = Date.now();
        tui['renderRequested'] = false;
        if (tui['stopped']) return;
        (doRender as () => void).call(this.tui);
        this.diagnostics?.recordRenderCompleted(Date.now() - startedAt);
      });
    };
  }
}
