import { appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.cortex', 'logs');
const LOG_FILE = join(LOG_DIR, 'cortex-code.log');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 5;

let initialized = false;
let currentSize = 0;

function ensureLogDir(): void {
  if (initialized) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    // Seed in-memory size from the existing file
    try {
      currentSize = statSync(LOG_FILE).size;
    } catch {
      currentSize = 0;
    }
    initialized = true;
  } catch {
    // If we can't create the log dir, logging silently fails
  }
}

function rotateIfNeeded(): void {
  if (currentSize < MAX_FILE_SIZE) return;

  try {
    // Delete the oldest rotated file
    const oldest = `${LOG_FILE}.${MAX_ROTATED_FILES}`;
    try { unlinkSync(oldest); } catch { /* may not exist */ }

    // Shift existing rotated files: .4 -> .5, .3 -> .4, etc.
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      try { renameSync(from, to); } catch { /* may not exist */ }
    }

    // Rotate current file to .1
    try { renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* may not exist */ }

    currentSize = 0;
  } catch {
    // If rotation fails, keep writing to the current file
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function write(level: string, message: string, data?: unknown): void {
  ensureLogDir();
  try {
    rotateIfNeeded();
    let line = `[${formatTimestamp()}] [${level}] ${message}`;
    if (data !== undefined) {
      try {
        line += ' ' + JSON.stringify(data);
      } catch {
        line += ' [unserializable]';
      }
    }
    line += '\n';
    appendFileSync(LOG_FILE, line);
    currentSize += Buffer.byteLength(line);
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
