import type { RichBlock } from '../types';

/**
 * Book-length jobs hold the source and the translation at once — several
 * megabytes for a novel — which is past what localStorage will take. IndexedDB
 * handles it, and a job survives a refresh mid-run.
 */

export interface GlossaryEntry {
  source: string;
  target: string;
  note?: string;
  keepAsIs?: boolean;
}

export interface TranslationBrief {
  detectedSourceLanguage: string;
  genre: string;
  narrativeVoice: string;
  register: string;
  tense: string;
  formality: string;
  rhythmNotes: string;
  culturalNotes: string;
  translatorGuidance: string;
  glossary: GlossaryEntry[];
}

export interface TranslationSegment {
  index: number;
  label: string;
  startBlock: number;
  endBlock: number;
  words: number;
}

export type SegmentStage = 'pending' | 'translating' | 'translated' | 'polishing' | 'done' | 'error';

export interface SegmentResult {
  blocks: RichBlock[];
  missing: number[];
  stage: SegmentStage;
  error?: string;
}

export interface TranslationJob {
  id: string;
  fileName: string;
  title: string;
  author: string;
  targetLanguage: string;
  authorNotes: string;
  wordCount: number;
  sourceBlocks: RichBlock[];
  segments: TranslationSegment[];
  brief: TranslationBrief | null;
  glossary: GlossaryEntry[];
  results: Record<number, SegmentResult>;
  polishEnabled: boolean;
  updatedAt: number;
}

const DB_NAME = 'bookforge-translation';
const STORE = 'jobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  } catch (error) {
    console.warn('[translation] storage unavailable:', error);
    return null;
  }
}

export function saveJob(job: TranslationJob): Promise<unknown> {
  return withStore('readwrite', (store) => store.put({ ...job, updatedAt: Date.now() }));
}

export function loadJob(id: string): Promise<TranslationJob | null> {
  return withStore<TranslationJob>('readonly', (store) => store.get(id));
}

export function listJobs(): Promise<TranslationJob[] | null> {
  return withStore<TranslationJob[]>('readonly', (store) => store.getAll());
}

export function deleteJob(id: string): Promise<unknown> {
  return withStore('readwrite', (store) => store.delete(id));
}

export function jobProgress(job: TranslationJob): {
  translated: number;
  done: number;
  errored: number;
  total: number;
  percent: number;
  wordsDone: number;
} {
  const total = job.segments.length;
  let translated = 0;
  let done = 0;
  let errored = 0;
  let wordsDone = 0;

  for (const segment of job.segments) {
    const result = job.results[segment.index];
    if (!result) continue;
    if (result.stage === 'error') errored++;
    if (result.stage === 'translated' || result.stage === 'done') {
      translated++;
      wordsDone += segment.words;
    }
    if (result.stage === 'done') done++;
  }

  const target = job.polishEnabled ? total * 2 : total;
  const achieved = job.polishEnabled ? translated + done : translated;
  return {
    translated,
    done,
    errored,
    total,
    percent: target === 0 ? 0 : Math.round((achieved / target) * 100),
    wordsDone,
  };
}
