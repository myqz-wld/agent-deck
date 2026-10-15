import * as snapshotFilesystem from 'node:fs';
import { snapshotContentsMatch } from './snapshot-store';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sessionAssetSelections } from './session-selection';

/** Claude keeps its startup plugin roots, so each session owns one stable, private view. */
export function sessionPluginView(destination: string, sessionId: string, paths: string[]): string[] {
  const selections = sessionAssetSelections(destination);
  const snapshot = paths.find(path => dirname(path) === `${destination}.versions`);
  if (!snapshot) return paths;
  if (!snapshotContentsMatch(snapshot, snapshot, snapshotFilesystem)) throw new Error('会话所选插件快照损坏。');
  let view = selections.getView(sessionId);
  if (!view) {
    const root = `${destination}.views`; mkdirSync(root, { recursive: true });
    view = join(root, randomUUID());
    try {
      cpSync(snapshot, view, { recursive: true });
      selections.setView(sessionId, view);
    } catch (error) {
      rmSync(view, { recursive: true, force: true }); throw error;
    }
  }
  if (!snapshotContentsMatch(view, snapshot, snapshotFilesystem)) {
    // A crash before committing a native refresh leaves the old selection authoritative.
    const staging = `${view}.staging-${randomUUID()}`;
    const backup = `${view}.backup-${randomUUID()}`;
    const hadView = existsSync(view);
    try {
      cpSync(snapshot, staging, { recursive: true });
      if (hadView) renameSync(view, backup);
      try { renameSync(staging, view); }
      catch (error) { if (hadView) renameSync(backup, view); throw error; }
      rmSync(backup, { recursive: true, force: true });
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  return paths.map(path => path === snapshot ? view! : path);
}

/** Call only behind the provider idle gate. Cache holds restore the prior files exactly. */
export function stagePluginView(destination: string, sessionId: string, snapshot: string) {
  const selections = sessionAssetSelections(destination);
  const view = selections.getView(sessionId);
  if (!view) return null;
  if (!snapshotContentsMatch(snapshot, snapshot, snapshotFilesystem)) throw new Error('候选插件快照损坏。');
  const old = selections.get(sessionId) ?? [];
  const staging = `${view}.staging-${randomUUID()}`;
  const backup = `${view}.backup-${randomUUID()}`;
  try {
    cpSync(snapshot, staging, { recursive: true });
    renameSync(view, backup);
    try { renameSync(staging, view); }
    catch (error) { renameSync(backup, view); throw error; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  let settled = false;
  return {
    path: view,
    changed: !old.includes(snapshot),
    commit() {
      if (settled) return;
      selections.replace(sessionId, [...old.filter(path => dirname(path) !== `${destination}.versions`), snapshot]);
      rmSync(backup, { recursive: true, force: true });
      settled = true;
    },
    restore() {
      if (settled) return;
      rmSync(view, { recursive: true, force: true });
      renameSync(backup, view);
      settled = true;
    },
  };
}

export function selectSessionPluginPaths(destination: string, sessionId: string | undefined, prepare: () => string[]): string[] {
  if (!sessionId) return prepare();
  return sessionPluginView(destination, sessionId, sessionAssetSelections(destination).select(sessionId, prepare));
}
