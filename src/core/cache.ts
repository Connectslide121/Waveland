import { ANALYSIS_VERSION } from './analysis/analyse';
import type { SongAnalysis } from './types';

const DB_NAME = 'waveland';
const DB_VERSION = 1;
const STORE = 'analyses';

/** One cached analysis, keyed by the song file's hash. */
export interface CachedAnalysis {
  hash: string;
  /** The `ANALYSIS_VERSION` that made it; other versions are ignored. */
  version: number;
  savedAt: number;
  analysis: SongAnalysis;
}

/** SHA-256 of the file's bytes, as hex: the same song gets the same key whatever its name. */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: 'hash' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

/**
 * The cached analysis for a file hash, or null when there is none, it came from another
 * analysis version, or the browser keeps no storage (private windows): then it is analysed again.
 */
export async function readCachedAnalysis(hash: string): Promise<SongAnalysis | null> {
  try {
    const db = await open();
    const record = await request<CachedAnalysis | undefined>(
      db.transaction(STORE).objectStore(STORE).get(hash),
    );
    return record?.version === ANALYSIS_VERSION ? record.analysis : null;
  } catch (error) {
    console.warn('Could not read the analysis cache', error);
    return null;
  }
}

/** Keep an analysis for next time. Failing to store it only costs a re-analysis later. */
export async function writeCachedAnalysis(hash: string, analysis: SongAnalysis): Promise<void> {
  try {
    const db = await open();
    const record: CachedAnalysis = {
      hash,
      version: ANALYSIS_VERSION,
      savedAt: Date.now(),
      analysis,
    };
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) {
    console.warn('Could not store the analysis in the cache', error);
  }
}
