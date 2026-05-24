// Default file-based session store. Cookies are written to a JSON file under
// the OS-appropriate per-user data directory:
//
//   macOS    ~/Library/Application Support/israeli-pension-scrapers/
//   Windows  %APPDATA%\israeli-pension-scrapers\
//   Linux    $XDG_DATA_HOME/israeli-pension-scrapers/
//            (falls back to ~/.local/share/israeli-pension-scrapers/)
//
// A consumer that wants encryption, an existing vault, or any other backing
// store can implement the SessionStore interface themselves and pass it to
// `scrapePension`.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore } from './types.js';

// Sessions older than this are dropped unused — replaying long-dead cookies
// just wastes a navigation, and the cap bounds how long a leaked bundle is
// useful.
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface SessionBundle {
  savedAt: number;
  cookies: unknown[];
}

/**
 * Picks the OS-conventional per-user data directory for `appName`. Used to
 * keep the default session store self-locating — consumers can override it
 * with `createFileSessionStore({ baseDir })` if they have a preferred path.
 */
export function defaultDataDir(appName = 'israeli-pension-scrapers'): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', appName);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, appName);
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return join(xdg, appName);
}

export interface FileSessionStoreOptions {
  /** Override the on-disk root. Defaults to the OS per-user data dir. */
  baseDir?: string;
  /** Override the default app/folder name under the data dir. */
  appName?: string;
  /** TTL in ms; bundles older than this are ignored on `load`. */
  maxAgeMs?: number;
}

/**
 * Creates a {@link SessionStore} that writes one JSON file per connection
 * under the OS data directory. Safe to share between processes.
 */
export function createFileSessionStore(opts: FileSessionStoreOptions = {}): SessionStore {
  const dir = opts.baseDir ?? defaultDataDir(opts.appName ?? 'israeli-pension-scrapers');
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  // Cookies are scoped per connection: a single provider key would prevent
  // a consumer running two member portals under one process (e.g. their own
  // pension plus a partner's), and the file name is the only namespace.
  const pathFor = (connectionId: string): string =>
    join(dir, `session-${sanitise(connectionId)}.json`);

  return {
    async load(connectionId) {
      try {
        const file = pathFor(connectionId);
        if (!existsSync(file)) return null;
        const bundle = JSON.parse(readFileSync(file, 'utf8')) as SessionBundle;
        if (
          !Array.isArray(bundle.cookies) ||
          bundle.cookies.length === 0 ||
          Date.now() - bundle.savedAt > maxAgeMs
        ) {
          return null;
        }
        return bundle.cookies;
      } catch {
        return null;
      }
    },
    async save(connectionId, cookies) {
      try {
        if (!cookies || cookies.length === 0) return;
        mkdirSync(dir, { recursive: true });
        const bundle: SessionBundle = { savedAt: Date.now(), cookies };
        writeFileSync(pathFor(connectionId), JSON.stringify(bundle), 'utf8');
      } catch {
        /* best effort — a failed save just means the next sync signs in fresh */
      }
    },
  };
}

/** Strips path separators and other risky characters from a connection id. */
function sanitise(id: string): string {
  return id.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) || 'default';
}
