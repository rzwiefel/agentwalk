import type { CodeGraph, RepositoryInfo } from './types';

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

export function loadRepository(path: string, options: { signal?: AbortSignal } = {}) {
  const query = new URLSearchParams();
  if (path.trim()) query.set('path', path.trim());
  return fetch(`/api/repository?${query.toString()}`, { signal: options.signal }).then(response => readJson<RepositoryInfo>(response));
}

export function loadRevision(path: string, commit: string, options: { signal?: AbortSignal } = {}) {
  const query = new URLSearchParams({ path, commit });
  return fetch(`/api/graph?${query.toString()}`, { signal: options.signal }).then(response => readJson<CodeGraph>(response));
}
