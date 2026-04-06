import type { SlashCommand } from '@mariozechner/pi-tui';
import { getCommands } from '../commands/index.js';

/**
 * Build slash commands for pi-tui's CombinedAutocompleteProvider.
 * Each registered command becomes a slash command available in the editor.
 */
export function buildSlashCommands(): SlashCommand[] {
  return getCommands().map(cmd => ({
    name: cmd.name,
    description: cmd.description,
  }));
}
