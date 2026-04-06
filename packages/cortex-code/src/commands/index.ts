import { fuzzyFilter } from '@mariozechner/pi-tui';
import { helpCommand } from './help.js';
import { clearCommand } from './clear.js';
import { compactCommand } from './compact.js';
import { modelCommand, providerCommand, utilityModelCommand } from './model.js';
import { costCommand } from './cost.js';
import { contextWindowCommand } from './context-window.js';
import { resumeCommand } from './resume.js';
import { loginCommand } from './login.js';
import { logoutCommand } from './logout.js';
import { yoloCommand } from './yolo.js';
import { effortCommand } from './effort.js';
import { exitCommand } from './exit.js';

// Handler type uses `any` for the session parameter to avoid circular
// dependency with session.ts. Type safety is enforced at the call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandHandler = (session: any) => Promise<void> | void;

export interface Command {
  name: string;
  description: string;
  handler: CommandHandler;
}

const commands = new Map<string, Command>();

export function registerCommand(command: Command): void {
  commands.set(command.name, command);
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name);
}

export function getCommands(): Command[] {
  return [...commands.values()];
}

/**
 * Filter commands using pi-tui's fuzzyFilter.
 * Returns commands whose names fuzzy-match the query, sorted by score.
 */
export function fuzzyFilterCommands(query: string): Command[] {
  if (!query) return getCommands();

  const all = getCommands();
  return fuzzyFilter(all, query, (cmd) => cmd.name);
}

/**
 * Register all built-in commands.
 * Called once at startup.
 */
export function registerBuiltinCommands(): void {
  registerCommand(helpCommand);
  registerCommand(clearCommand);
  registerCommand(compactCommand);
  registerCommand(modelCommand);
  registerCommand(providerCommand);
  registerCommand(utilityModelCommand);
  registerCommand(costCommand);
  registerCommand(contextWindowCommand);
  registerCommand(resumeCommand);
  registerCommand(loginCommand);
  registerCommand(logoutCommand);
  registerCommand(yoloCommand);
  registerCommand(effortCommand);
  registerCommand(exitCommand);
}
