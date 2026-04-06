import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.cortex', 'logs');
const LOG_FILE = join(LOG_DIR, 'cortex-code.log');

let initialized = false;

function ensureLogDir(): void {
  if (initialized) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    initialized = true;
  } catch {
    // If we can't create the log dir, logging silently fails
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function write(level: string, message: string, data?: unknown): void {
  ensureLogDir();
  try {
    let line = `[${formatTimestamp()}] [${level}] ${message}`;
    if (data !== undefined) {
      try {
        line += ' ' + JSON.stringify(data);
      } catch {
        line += ' [unserializable]';
      }
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Swallow write errors
  }
}

export const log = {
  debug: (message: string, data?: unknown) => write('DEBUG', message, data),
  info: (message: string, data?: unknown) => write('INFO', message, data),
  warn: (message: string, data?: unknown) => write('WARN', message, data),
  error: (message: string, data?: unknown) => write('ERROR', message, data),
};
