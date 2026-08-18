import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));

import {
  parseBrowserPresentationBegin,
  parseBrowserPresentationPark,
  parseBrowserPresentationTab,
  parseBrowserPresentationUpdate,
  parseBrowserStateSource,
} from '../browser-input';

describe('Browser presentation IPC input', () => {
  it('accepts only exact Local and Remote source authorities', () => {
    expect(parseBrowserStateSource({ kind: 'local', sessionId: 'session-a' })).toEqual({
      kind: 'local', sessionId: 'session-a',
    });
    expect(parseBrowserStateSource({
      kind: 'remote', profileId: 'profile-a', coreId: 'core-a', generation: null,
      sessionId: 'session-a',
    })).toEqual({
      kind: 'remote', profileId: 'profile-a', coreId: 'core-a', generation: null,
      sessionId: 'session-a',
    });
    expect(() => parseBrowserStateSource({
      kind: 'local', sessionId: 'session-a', ownerId: 'spoofed-owner',
    })).toThrow(/exactly/);
    expect(() => parseBrowserStateSource({
      kind: 'remote', profileId: 'p', coreId: 'c', generation: -1, sessionId: 's',
    })).toThrow(/generation/);
  });

  it('requires the renderer to present one current positive revision', () => {
    expect(parseBrowserPresentationBegin({
      source: { kind: 'local', sessionId: 'session-a' }, expectedRevision: 4,
    })).toMatchObject({ expectedRevision: 4 });
    expect(() => parseBrowserPresentationBegin({
      source: { kind: 'local', sessionId: 'session-a' }, expectedRevision: 0,
    })).toThrow(/expectedRevision/);
    expect(() => parseBrowserPresentationBegin({
      source: { kind: 'local', sessionId: 'session-a' }, expectedRevision: 4,
      windowId: 7,
    })).toThrow(/exactly/);
  });

  it('bounds native view placement to integral content coordinates', () => {
    expect(parseBrowserPresentationUpdate({
      leaseId: 'lease-a', tabId: 2,
      bounds: { x: 10, y: 80, width: 480, height: 600 },
    })).toEqual({
      leaseId: 'lease-a', tabId: 2,
      bounds: { x: 10, y: 80, width: 480, height: 600 },
    });
    for (const bounds of [
      { x: -1, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 0, height: 100 },
      { x: 0.5, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 20_000, height: 100 },
    ]) {
      expect(() => parseBrowserPresentationUpdate({
        leaseId: 'lease-a', tabId: 2, bounds,
      })).toThrow(/bounds/);
    }
  });

  it('does not accept identity fields on tab or park commands', () => {
    expect(parseBrowserPresentationTab({ leaseId: 'lease-a', tabId: 1 })).toEqual({
      leaseId: 'lease-a', tabId: 1,
    });
    expect(parseBrowserPresentationPark({ leaseId: 'lease-a' })).toEqual({
      leaseId: 'lease-a',
    });
    expect(() => parseBrowserPresentationPark({
      leaseId: 'lease-a', sessionId: 'session-a',
    })).toThrow(/exactly/);
  });
});
