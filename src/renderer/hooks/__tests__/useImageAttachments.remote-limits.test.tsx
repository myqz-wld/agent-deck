// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@renderer/stores/session-store';
import { resetImageAttachmentSidecarForTests } from '../image-attachments/payload-sidecar';
import { useImageAttachments } from '../useImageAttachments';

beforeEach(() => {
  resetImageAttachmentSidecarForTests();
  useSessionStore.setState({
    sessions: new Map(),
    composerBySession: new Map(),
    composerAliases: new Map(),
    composerRequestSequence: 0,
  });
  class Reader {
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(): void {
      this.result = 'data:image/png;base64,YQ==';
      queueMicrotask(() => this.onload?.());
    }
  }
  class LoadedImage {
    width = 1;
    height = 1;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('FileReader', Reader as unknown as typeof FileReader);
  vi.stubGlobal('Image', LoadedImage as unknown as typeof Image);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
    globalCompositeOperation: '',
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/jpeg;base64,YQ==');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useImageAttachments Remote descriptor limits', () => {
  it('enforces negotiated count and MIME before committing payloads', async () => {
    const limits = {
      maxBytesEach: 2 * 1024 * 1024,
      maxBytesTotal: 2 * 1024 * 1024,
      maxCount: 1,
      mimeTypes: ['image/png'],
    } as const;
    const { result } = renderHook(() => useImageAttachments('remote-limit', limits));
    await act(async () => {
      await result.current.add([
        new File([new Uint8Array(1)], 'first.png', { type: 'image/png' }),
        new File([new Uint8Array(1)], 'second.png', { type: 'image/png' }),
      ]);
    });
    expect(result.current.attachments.map((attachment) => attachment.name)).toEqual(['first.png']);
    expect(result.current.error).toContain('图片数量超过 1 张上限');

    await act(async () => {
      await result.current.add([
        new File([new Uint8Array(1)], 'photo.jpg', { type: 'image/jpeg' }),
      ]);
    });
    expect(result.current.error).toContain('当前会话不支持 image/jpeg');
  });
});
