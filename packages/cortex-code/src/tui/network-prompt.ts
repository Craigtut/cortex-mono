import { Box, Text, SelectList, type SelectItem, type Component } from '@earendil-works/pi-tui';
import { colors, selectListTheme } from './theme.js';
import { sanitizeTerminalLine } from './renderers/sanitize-terminal.js';
import type { NetworkAccessRequest } from '@animus-labs/cortex';
import type { NetworkPromptChoice } from '../permissions/network.js';

type NetworkPromptCallback = (choice: NetworkPromptChoice) => void;

/**
 * Inline prompt for the unified network access decision. One wording for both
 * egress paths; the source line says whether a shell command or WebFetch is
 * asking, since that context changes how a user judges an unfamiliar host.
 */
export class NetworkPromptComponent implements Component {
  private box: Box;
  private selectList: SelectList;
  private resolved = false;

  constructor(
    private req: NetworkAccessRequest,
    private callback: NetworkPromptCallback,
  ) {
    this.box = new Box(1, 0);

    const headerLine = colors.primaryMuted('\u2500\u2500\u2500 Network Access ' + '\u2500'.repeat(44));
    this.box.addChild(new Text(headerLine));

    // Host and URL are model-controlled; sanitize so a prompt-injected fetch
    // cannot forge or overwrite this dialog via ANSI/OSC escapes.
    this.box.addChild(new Text(colors.bold(sanitizeTerminalLine(`Allow the agent to reach ${req.host}?`))));
    const viaLabel = req.via === 'shell' ? 'Requested by a shell command' : 'Requested by WebFetch';
    const detail = req.via === 'webfetch' && req.url ? `${viaLabel}: ${req.url}` : viaLabel;
    this.box.addChild(new Text(colors.white(sanitizeTerminalLine(detail))));
    this.box.addChild(new Text('')); // spacing

    const items: SelectItem[] = [
      { value: 'once', label: 'Allow once' },
      { value: 'session', label: 'Allow for this session' },
      { value: 'always', label: sanitizeTerminalLine(`Always allow ${req.host} in this project`) },
      { value: 'deny', label: 'Deny' },
    ];

    this.selectList = new SelectList(items, items.length, selectListTheme);

    this.selectList.onSelect = (item) => {
      if (this.resolved) return;
      this.resolved = true;
      this.callback(item.value as NetworkPromptChoice);
    };

    this.selectList.onCancel = () => {
      if (this.resolved) return;
      this.resolved = true;
      this.callback('deny');
    };

    this.box.addChild(this.selectList);
  }

  handleInput(data: string): void {
    if (!this.resolved) {
      this.selectList.handleInput(data);
    }
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width);
  }
}
