import type { DocumentChapter } from '../types';

const KEY = 'bookforge_workspace_v1';
const MAX_BYTES = 4 * 1024 * 1024; // keep well clear of the ~5MB localStorage ceiling

export interface Workspace {
  title: string;
  subtitle: string;
  author: string;
  chapters: DocumentChapter[];
  selectedChapterId: string;
  savedAt: number;
}

export function loadWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Workspace;
    if (!Array.isArray(parsed.chapters) || parsed.chapters.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Best-effort autosave. Silently gives up when the manuscript exceeds the quota. */
export function saveWorkspace(workspace: Omit<Workspace, 'savedAt'>): boolean {
  try {
    const payload = JSON.stringify({ ...workspace, savedAt: Date.now() });
    if (payload.length > MAX_BYTES) return false;
    localStorage.setItem(KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function describeAge(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
