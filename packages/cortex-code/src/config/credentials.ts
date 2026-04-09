import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';

const execFileAsync = promisify(execFile);

export interface CredentialEntry {
  provider: string;
  method: 'oauth' | 'api_key' | 'custom';
  apiKey?: string;
  oauthCredentials?: string;
  oauthMeta?: {
    displayName?: string | undefined;
    expiresAt?: number | undefined;
    refreshable: boolean;
  };
  baseUrl?: string;
  modelId?: string;
  connectionName?: string;
  addedAt: number;
  lastUsed?: number;
}

export interface CredentialFile {
  version: 1;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
  providers: Record<string, CredentialEntry>;
}

const CREDENTIALS_PATH = join(homedir(), '.cortex', 'credentials.json');
const KEYCHAIN_SERVICE = 'cortex-code';

function emptyCredentialFile(): CredentialFile {
  return {
    version: 1,
    defaultProvider: null,
    defaultModel: null,
    defaultEffort: null,
    providers: {},
  };
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readCredentialFile(): Promise<CredentialFile> {
  try {
    const content = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(content) as CredentialFile;
  } catch {
    return emptyCredentialFile();
  }
}

async function writeCredentialFile(data: CredentialFile): Promise<void> {
  await ensureDir(CREDENTIALS_PATH);
  await writeFile(CREDENTIALS_PATH, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  await chmod(CREDENTIALS_PATH, 0o600);
}

// Opportunistic macOS Keychain integration via `security` CLI.
// Falls back silently if Keychain is unavailable.
async function keychainGet(account: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
      '-w',
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function keychainSet(account: string, password: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    // Delete existing entry first (ignore errors if it doesn't exist)
    try {
      await execFileAsync('security', [
        'delete-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', account,
      ]);
    } catch {
      // Entry doesn't exist, that's fine
    }
    await execFileAsync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
      '-w', password,
      '-U',
    ]);
    return true;
  } catch {
    return false;
  }
}

async function keychainDelete(account: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
    ]);
  } catch {
    // Ignore if entry doesn't exist
  }
}

export class CredentialStore {
  /** Load all credentials from disk. */
  async load(): Promise<CredentialFile> {
    return readCredentialFile();
  }

  /** Get a specific provider's credentials. */
  async getProvider(providerId: string): Promise<CredentialEntry | null> {
    const file = await readCredentialFile();
    const entry = file.providers[providerId];
    if (!entry) return null;

    // Try Keychain for API key on macOS
    if (entry.method === 'api_key' && !entry.apiKey) {
      const keychainKey = await keychainGet(providerId);
      if (keychainKey) {
        return { ...entry, apiKey: keychainKey };
      }
    }

    return entry;
  }

  /** Save or update a provider's credentials. Acquires file lock. */
  async setProvider(providerId: string, entry: CredentialEntry): Promise<void> {
    await ensureDir(CREDENTIALS_PATH);
    let release: (() => Promise<void>) | undefined;
    try {
      // Ensure the file exists before locking
      try {
        await readFile(CREDENTIALS_PATH);
      } catch {
        await writeCredentialFile(emptyCredentialFile());
      }
      release = await lockfile.lock(CREDENTIALS_PATH, { retries: 3 });
      const file = await readCredentialFile();

      // Opportunistically store API key in Keychain
      const entryToStore: CredentialEntry = { ...entry };
      if (entry.method === 'api_key' && entry.apiKey) {
        const stored = await keychainSet(providerId, entry.apiKey);
        if (stored) {
          // Key is in Keychain, don't store in plaintext file
          delete entryToStore.apiKey;
        }
      }

      file.providers[providerId] = entryToStore;
      await writeCredentialFile(file);
    } finally {
      if (release) await release();
    }
  }

  /** Remove a provider's credentials. */
  async removeProvider(providerId: string): Promise<void> {
    await ensureDir(CREDENTIALS_PATH);
    let release: (() => Promise<void>) | undefined;
    try {
      try {
        await readFile(CREDENTIALS_PATH);
      } catch {
        return; // No file, nothing to remove
      }
      release = await lockfile.lock(CREDENTIALS_PATH, { retries: 3 });
      const file = await readCredentialFile();
      delete file.providers[providerId];

      // Also remove from Keychain
      await keychainDelete(providerId);

      await writeCredentialFile(file);
    } finally {
      if (release) await release();
    }
  }

  /** Get default provider and model. */
  async getDefaults(): Promise<{ provider: string | null; model: string | null }> {
    const file = await readCredentialFile();
    return {
      provider: file.defaultProvider,
      model: file.defaultModel,
    };
  }

  /** Set default provider and model. */
  async setDefaults(provider: string, model: string): Promise<void> {
    await ensureDir(CREDENTIALS_PATH);
    let release: (() => Promise<void>) | undefined;
    try {
      try {
        await readFile(CREDENTIALS_PATH);
      } catch {
        await writeCredentialFile(emptyCredentialFile());
      }
      release = await lockfile.lock(CREDENTIALS_PATH, { retries: 3 });
      const file = await readCredentialFile();
      file.defaultProvider = provider;
      file.defaultModel = model;
      await writeCredentialFile(file);
    } finally {
      if (release) await release();
    }
  }

  /** Get the persisted default effort level. */
  async getDefaultEffort(): Promise<string | null> {
    const file = await readCredentialFile();
    return file.defaultEffort ?? null;
  }

  /** Persist the default effort level. */
  async setDefaultEffort(effort: string): Promise<void> {
    await ensureDir(CREDENTIALS_PATH);
    let release: (() => Promise<void>) | undefined;
    try {
      try {
        await readFile(CREDENTIALS_PATH);
      } catch {
        await writeCredentialFile(emptyCredentialFile());
      }
      release = await lockfile.lock(CREDENTIALS_PATH, { retries: 3 });
      const file = await readCredentialFile();
      file.defaultEffort = effort;
      await writeCredentialFile(file);
    } finally {
      if (release) await release();
    }
  }

  /** Check if any providers are configured. */
  async hasProviders(): Promise<boolean> {
    const file = await readCredentialFile();
    return Object.keys(file.providers).length > 0;
  }
}
