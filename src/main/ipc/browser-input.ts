import type {
  BrowserPresentationBeginRequest,
  BrowserPresentationParkRequest,
  BrowserPresentationTabRequest,
  BrowserPresentationUpdateRequest,
  BrowserStateSource,
  BrowserViewBounds,
} from '@shared/browser-view';

import { IpcInputError, parseStringId } from './_helpers';

function record(field: string, value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IpcInputError(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(field: string, value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new IpcInputError(field, `must contain exactly ${wanted.join('|')}`);
  }
}

function safeInteger(field: string, value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new IpcInputError(field, `must be an integer in [${min}, ${max}]`);
  }
  return value as number;
}

export function parseBrowserStateSource(value: unknown): BrowserStateSource {
  const source = record('source', value);
  if (source.kind === 'local') {
    exactKeys('source', source, ['kind', 'sessionId']);
    return { kind: 'local', sessionId: parseStringId('source.sessionId', source.sessionId) };
  }
  if (source.kind === 'remote') {
    exactKeys('source', source, [
      'kind', 'profileId', 'coreId', 'generation', 'sessionId',
    ]);
    const generation = source.generation === null
      ? null
      : safeInteger('source.generation', source.generation, 0, Number.MAX_SAFE_INTEGER);
    return {
      kind: 'remote',
      profileId: parseStringId('source.profileId', source.profileId),
      coreId: parseStringId('source.coreId', source.coreId),
      generation,
      sessionId: parseStringId('source.sessionId', source.sessionId),
    };
  }
  throw new IpcInputError('source.kind', "must be 'local' or 'remote'");
}

export function parseBrowserPresentationBegin(
  value: unknown,
): BrowserPresentationBeginRequest {
  const request = record('request', value);
  exactKeys('request', request, ['source', 'expectedRevision']);
  return {
    source: parseBrowserStateSource(request.source),
    expectedRevision: safeInteger(
      'request.expectedRevision', request.expectedRevision, 1, Number.MAX_SAFE_INTEGER,
    ),
  };
}

function parseBounds(value: unknown): BrowserViewBounds {
  const bounds = record('request.bounds', value);
  exactKeys('request.bounds', bounds, ['x', 'y', 'width', 'height']);
  return {
    x: safeInteger('request.bounds.x', bounds.x, 0, 16_384),
    y: safeInteger('request.bounds.y', bounds.y, 0, 16_384),
    width: safeInteger('request.bounds.width', bounds.width, 1, 16_384),
    height: safeInteger('request.bounds.height', bounds.height, 1, 16_384),
  };
}

export function parseBrowserPresentationUpdate(
  value: unknown,
): BrowserPresentationUpdateRequest {
  const request = record('request', value);
  exactKeys('request', request, ['leaseId', 'tabId', 'bounds']);
  return {
    leaseId: parseStringId('request.leaseId', request.leaseId, 128),
    tabId: safeInteger('request.tabId', request.tabId, 1, Number.MAX_SAFE_INTEGER),
    bounds: parseBounds(request.bounds),
  };
}

export function parseBrowserPresentationTab(value: unknown): BrowserPresentationTabRequest {
  const request = record('request', value);
  exactKeys('request', request, ['leaseId', 'tabId']);
  return {
    leaseId: parseStringId('request.leaseId', request.leaseId, 128),
    tabId: safeInteger('request.tabId', request.tabId, 1, Number.MAX_SAFE_INTEGER),
  };
}

export function parseBrowserPresentationPark(value: unknown): BrowserPresentationParkRequest {
  const request = record('request', value);
  exactKeys('request', request, ['leaseId']);
  return { leaseId: parseStringId('request.leaseId', request.leaseId, 128) };
}
