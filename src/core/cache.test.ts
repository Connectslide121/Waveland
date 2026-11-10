import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_VERSION } from './analysis/analyse';
import { hashBytes, readCachedAnalysis, writeCachedAnalysis } from './cache';
import type { SongAnalysis } from './types';

const curve = () => ({ step: 0.02, values: Float32Array.of(0, 0.5, 1) });
const analysis: SongAnalysis = {
  duration: 3,
  tempo: 120,
  beats: [0.5, 1, 1.5],
  downbeats: [0.5],
  onsets: { low: [{ time: 0.5, strength: 1 }], mid: [], high: [] },
  energy: curve(),
  bands: { low: curve(), mid: curve(), high: curve() },
  sections: [{ start: 0, end: 3, kind: 'main', energy: 0.5 }],
  drops: [],
};

/** Put a record straight into the cache's store, as an older version would have. */
async function putRaw(record: object) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('waveland');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('analyses', 'readwrite');
    tx.objectStore('analyses').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('hashBytes', () => {
  it('gives the same hex SHA-256 for the same bytes, and another for other bytes', async () => {
    const a = await hashBytes(new TextEncoder().encode('song').buffer);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashBytes(new TextEncoder().encode('song').buffer)).toBe(a);
    expect(await hashBytes(new TextEncoder().encode('other').buffer)).not.toBe(a);
  });
});

describe('analysis cache', () => {
  it('returns null for a song it has not seen', async () => {
    expect(await readCachedAnalysis('unknown')).toBeNull();
  });

  it('gives back a stored analysis, typed arrays included', async () => {
    await writeCachedAnalysis('abc', analysis);
    const read = await readCachedAnalysis('abc');
    expect(read?.tempo).toBe(120);
    // By name: the test's fake IndexedDB clones in Node's realm, not jsdom's.
    expect(read?.bands.low.values.constructor.name).toBe('Float32Array');
    expect([...read!.energy.values]).toEqual([0, 0.5, 1]);
  });

  it('ignores an analysis made by another analysis version', async () => {
    await writeCachedAnalysis('old', analysis);
    await putRaw({ hash: 'old', version: ANALYSIS_VERSION - 1, savedAt: 0, analysis });
    expect(await readCachedAnalysis('old')).toBeNull();
  });
});
