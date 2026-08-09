import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type { DiffPayload, FileChangePayload, FileChangeSummary, FileFinalDiffResult } from '@shared/types';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { decodeBlob, groupFileChanges } from './helpers';
import { DiffTab } from './DiffTab';
import { useFileChangeSelection } from './use-file-change-selection';
import type { FileChangeLoadSummary } from './use-file-changes';

type DiffMode = 'single' | 'final';

function mergeChanges(
  current: readonly FileChangeSummary[],
  incoming: readonly FileChangeSummary[],
): FileChangeSummary[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => right.ts - left.ts || right.id - left.id);
}

export function RemoteDiffPanel({ source }: { source: RemoteSessionSourceView }): JSX.Element {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const sessionId = source.selectedSessionId ?? '';
  const workspaceKey = `${source.identity}:${sessionId}`;
  const [changes, setChanges] = useState<FileChangeSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastLoadSummary, setLastLoadSummary] = useState<FileChangeLoadSummary | null>(null);
  const [payload, setPayload] = useState<FileChangePayload | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>('single');
  const [finalDiff, setFinalDiff] = useState<FileFinalDiffResult | null>(null);
  const [finalDiffLoading, setFinalDiffLoading] = useState(false);
  const listGeneration = useRef(0);
  const listWorkspace = useRef<string | null>(null);
  const payloadGeneration = useRef(0);
  const finalGeneration = useRef(0);
  const selection = useFileChangeSelection({ changes, sessionId, workspaceKey });
  const groups = useMemo(() => groupFileChanges(changes ?? []), [changes]);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.filePath === selection.selectedFilePath) ?? null,
    [groups, selection.selectedFilePath],
  );

  const loadFirstPage = async (incremental: boolean): Promise<void> => {
    const current = ++listGeneration.current;
    setLoadingMore(false);
    if (!incremental) {
      setChanges(null);
      setNextCursor(null);
      setLastLoadSummary(null);
    }
    setError(null);
    try {
      const page = await sourceRef.current.listFileChanges();
      if (current !== listGeneration.current) return;
      setChanges((existing) => incremental && existing
        ? mergeChanges(existing, page.items)
        : page.items);
      setNextCursor((existing) => incremental && existing !== null
        ? existing
        : page.nextCursor);
    } catch (reason) {
      if (current === listGeneration.current) {
        setError(reason instanceof Error ? reason.message : '无法加载远程文件改动。');
      }
    }
  };

  useEffect(() => {
    const incremental = listWorkspace.current === workspaceKey;
    listWorkspace.current = workspaceKey;
    void loadFirstPage(incremental);
    return () => { listGeneration.current += 1; };
    // The source revision is the stable same-identity refresh boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.dataRevision, workspaceKey]);

  useEffect(() => () => {
    payloadGeneration.current += 1;
    finalGeneration.current += 1;
  }, [workspaceKey]);

  useEffect(() => {
    const current = ++payloadGeneration.current;
    const changeId = selection.selectedChangeId;
    setPayload(null);
    setPayloadError(null);
    if (changeId === null) {
      setPayloadLoading(false);
      return;
    }
    setPayloadLoading(true);
    void sourceRef.current.getFileChange(changeId).then((result) => {
      if (current !== payloadGeneration.current) return;
      if (!result.change) setPayloadError('找不到当前远程 session 中的文件改动。');
      else setPayload(result.change);
    }).catch((reason: unknown) => {
      if (current === payloadGeneration.current) {
        setPayloadError(reason instanceof Error ? reason.message : '无法加载所选远程改动。');
      }
    }).finally(() => {
      if (current === payloadGeneration.current) setPayloadLoading(false);
    });
  }, [selection.selectedChangeId, workspaceKey]);

  useEffect(() => {
    const filePath = selection.selectedFilePath;
    if (diffMode !== 'final' || !filePath) return;
    const current = ++finalGeneration.current;
    setFinalDiff(null);
    setFinalDiffLoading(true);
    void sourceRef.current.getFileFinalDiff(filePath).then((result) => {
      if (current === finalGeneration.current) setFinalDiff(result.fileDiff);
    }).catch((reason: unknown) => {
      if (current === finalGeneration.current) {
        setFinalDiff({
          ok: false,
          filePath,
          diff: null,
          source: 'recorded-snapshot',
          reason: 'snapshot_unavailable',
          message: reason instanceof Error ? reason.message : '无法加载远程最终 diff。',
        });
      }
    }).finally(() => {
      if (current === finalGeneration.current) setFinalDiffLoading(false);
    });
  }, [diffMode, selectedGroup?.lastId, selection.selectedFilePath, workspaceKey]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMore) return;
    const current = ++listGeneration.current;
    setLoadingMore(true);
    setLastLoadSummary(null);
    try {
      const page = await sourceRef.current.listFileChanges(nextCursor);
      if (current !== listGeneration.current) return;
      const existing = changes ?? [];
      const ids = new Set(existing.map((item) => item.id));
      const paths = new Set(existing.map((item) => item.filePath));
      const added = page.items.filter((item) => !ids.has(item.id));
      setChanges(mergeChanges(existing, page.items));
      setNextCursor(page.nextCursor);
      setLastLoadSummary({
        addedChangeCount: added.length,
        addedFileCount: new Set(added.filter((item) => !paths.has(item.filePath))
          .map((item) => item.filePath)).size,
        exhausted: page.nextCursor === null,
      });
    } catch (reason) {
      if (current === listGeneration.current) {
        setError(reason instanceof Error ? reason.message : '无法加载更早远程改动。');
      }
    } finally {
      if (current === listGeneration.current) setLoadingMore(false);
    }
  };

  const diffPayload: DiffPayload | null = payload ? {
    kind: payload.kind,
    filePath: payload.filePath,
    before: decodeBlob(payload.kind, payload.beforeSnapshot ?? payload.beforeBlob),
    after: decodeBlob(payload.kind, payload.afterSnapshot ?? payload.afterBlob),
    metadata: payload.metadata,
    toolCallId: payload.toolCallId ?? undefined,
    ts: payload.ts,
  } : null;
  const finalDiffPayload: DiffPayload | null = finalDiff?.ok && finalDiff.diff ? {
    kind: 'text',
    filePath: finalDiff.filePath,
    before: null,
    after: null,
    metadata: { source: finalDiff.source, diff: finalDiff.diff },
    ts: selectedGroup?.lastTs ?? 0,
  } : null;
  const selectGroup = (group: NonNullable<typeof selectedGroup>): void => {
    selection.selectFile(group.filePath, group.items[group.items.length - 1]!.id);
    setFinalDiff(null);
  };
  return (
    <DiffTab
      sessionId={sessionId}
      changes={changes}
      diffError={error}
      hasMore={nextCursor !== null}
      loadedCount={changes?.length ?? 0}
      loadingMore={loadingMore}
      lastLoadSummary={lastLoadSummary}
      hasNewerChanges={selection.hasNewerChanges}
      payloadLoading={payloadLoading}
      payloadError={payloadError}
      fileGroups={groups}
      selectedFilePath={selection.selectedFilePath}
      selectedGroup={selectedGroup}
      selectedChangeId={selection.selectedChangeId}
      diffMode={diffMode}
      finalDiffLoading={finalDiffLoading}
      finalDiff={finalDiff}
      diffPayload={diffPayload}
      finalDiffPayload={finalDiffPayload}
      imageBlobLoader={source.loadImageBlob}
      imageCacheScope={source.identity}
      onSelectFile={selectGroup}
      onSelectChange={(id) => { selection.selectChange(id); setDiffMode('single'); }}
      onDiffModeChange={setDiffMode}
      onLoadMore={() => void loadMore()}
      onFollowLatest={() => { selection.followLatest(); setDiffMode('single'); setFinalDiff(null); }}
      onRetry={() => void loadFirstPage(changes !== null)}
    />
  );
}
