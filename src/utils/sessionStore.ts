/**
 * Work in progress survives a refresh.
 *
 * A book-length narration is an hour of generated audio and, on a metered key,
 * a real amount of quota. Losing it to a stray refresh or a closed tab is not
 * acceptable, so both speech views checkpoint themselves as they go — no button
 * and nothing to remember; it simply happens.
 *
 * IndexedDB rather than localStorage because the payload is audio: a single
 * chapter is megabytes, and localStorage caps out around five for the whole
 * origin and only stores strings.
 */

const DB_NAME = 'bookforge-sessions';
const STORE = 'sessions';
const DB_VERSION = 1;

export interface AudiobookChapterSave {
  blob: Blob;
  seconds: number;
}

export interface AudiobookSession {
  fileName: string;
  /** Saved with the voice: a voice id only means something for its own engine. */
  engine?: 'kokoro' | 'gemini';
  doc: unknown;
  voice: string;
  style: string;
  announceChapters: boolean;
  /**
   * Which sections to narrate, by index. Absent on saves written before
   * skipping existed, in which case the default is derived from the document.
   */
  included?: Record<number, boolean>;
  /** Chapter index → finished audio. Failed chapters are simply absent. */
  chapters: Record<number, AudiobookChapterSave>;
  savedAt: number;
}

export interface SpeechSession {
  text: string;
  engine?: 'kokoro' | 'gemini';
  voice: string;
  style: string;
  /** Local-engine tempo; absent on sessions saved before it existed. */
  speed?: number;
  audio?: { pcm: Int16Array; sampleRate: number };
  savedAt: number;
}

export interface SessionMap {
  audiobook: AudiobookSession;
  speech: SpeechSession;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Saving must never break the thing it is protecting, so every failure here is
 * swallowed — a full disk or a private-mode browser should cost the autosave,
 * not the run.
 */
export async function saveSession<K extends keyof SessionMap>(key: K, value: SessionMap[K]): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.put(value, key));
  } catch {
    /* autosave is best-effort by design */
  }
}

export async function loadSession<K extends keyof SessionMap>(key: K): Promise<SessionMap[K] | null> {
  try {
    return (await withStore<SessionMap[K] | undefined>('readonly', (store) => store.get(key))) ?? null;
  } catch {
    return null;
  }
}

export async function clearSession(key: keyof SessionMap): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch {
    /* nothing to do if it will not clear */
  }
}

/** "3 minutes ago" — shown so the autosave is visibly working. */
export function savedAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
