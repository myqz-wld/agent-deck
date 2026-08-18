// @vitest-environment happy-dom
/** Async lifecycle, compression, animation, and logical-session attachment regressions. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSessionStore } from '@renderer/stores/session-store';
import {
  resetImageAttachmentSidecarForTests,
} from '../image-attachments/payload-sidecar';
import { useImageAttachments } from '../useImageAttachments';

/** MAX_BASE64_BYTES_FOR_API 镜像生产（5MB - 200KB safety margin）。 */
const MAX_BASE64_BYTES_FOR_API = 5 * 1024 * 1024 - 200 * 1024;

let imageOnloadQueue: Array<() => void> = [];

/**
 * 测试可控的 mock 钩子：每个 beforeEach 重置默认值，新测试可按需覆写。
 * - bigBase64: 非空字符串 → FakeFileReader 返回指定长度；null → 默认
 * - failImage: true → QueuedImage 触发 onerror（img.onerror 分支）；false → 默认 onload
 * - compressLengths: 非空数组 → canvas.toDataURL 按 callCount 一次返一档（模拟降档循环）；
 *   数组含 'no-ctx' 元素 → getContext 返回 null；null → 默认固定 JPEG
 */
let mockHooks: {
  bigBase64: string | null;
  failImage: boolean;
  compressLengths: Array<{ size: number } | 'no-ctx'> | null;
} = {
  bigBase64: null,
  failImage: false,
  compressLengths: null,
};

beforeEach(() => {
  resetImageAttachmentSidecarForTests();
  useSessionStore.setState({
    sessions: new Map(),
    composerBySession: new Map(),
    composerAliases: new Map(),
    composerRequestSequence: 0,
  });
  imageOnloadQueue = [];
  mockHooks = { bigBase64: null, failImage: false, compressLengths: null };

  class FakeFileReader {
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(file: Blob): void {
      const type = (file as File).type;
      if (mockHooks.bigBase64 !== null) {
        // Force compression with an oversized base64 string.
        this.result = 'data:' + type + ';base64,' + mockHooks.bigBase64;
      } else {
        // WebP defaults to an oversized payload for animation preflight coverage.
        this.result =
          type === 'image/webp'
            ? 'data:image/webp;base64,' + 'A'.repeat(5 * 1024 * 1024)
            : 'data:image/png;base64,aGVsbG8=';
      }
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('FileReader', FakeFileReader as unknown as typeof FileReader);

  // Image.onload 进手动队列 —— 控制 makeThumbnail 完成时机 = 控制 add() 内每张图的 push 时机
  class QueuedImage {
    width = 100;
    height = 100;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = '';
    set src(v: string) {
      this._src = v;
      // failImage=true 推 onerror 到队列；默认 onload 走 imageOnloadQueue（向后兼容老测试）。
      if (mockHooks.failImage) {
        imageOnloadQueue.push(() => this.onerror?.());
      } else {
        imageOnloadQueue.push(() => this.onload?.());
      }
    }
    get src(): string {
      return this._src;
    }
  }
  vi.stubGlobal('Image', QueuedImage as unknown as typeof Image);

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((..._args: unknown[]) => {
    // A no-ctx entry makes the corresponding compression attempt unavailable.
    const arr = mockHooks.compressLengths;
    if (arr) {
      const getCtxIdx = (HTMLCanvasElement.prototype.getContext as unknown as {
        mock: { calls: unknown[] };
      }).mock.calls.length - 1;
      if (arr[getCtxIdx] === 'no-ctx') {
        return null;
      }
    }
    return {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      globalCompositeOperation: '',
    };
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext);

  // toDataURL spy：根据 mockHooks.compressLengths 排队返回；callCount-1 取索引。
  // 兜底：未配 compressLengths 返固定小 jpeg（保持老测试行为）。
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(((
    _mime?: string,
    _quality?: number,
  ) => {
    const arr = mockHooks.compressLengths;
    if (!arr) {
      return 'data:image/jpeg;base64,dGh1bWI=';
    }
    // 索引 = 累计 toDataURL 调用次数 - 1（同一 canvas 多次调用 = 同一档再调；不同 canvas = 不同档）
    const idx = (HTMLCanvasElement.prototype.toDataURL as unknown as {
      mock: { calls: unknown[] };
    }).mock.calls.length - 1;
    const step = arr[idx];
    if (step && typeof step === 'object' && 'size' in step) {
      return 'data:image/jpeg;base64,' + 'A'.repeat(step.size);
    }
    // 索引越界 / 'no-ctx' 不会到 toDataURL（前者不应发生，后者 getContext 返 null 短路）。
    // 越界兜底：返超 MAX 大 base64，让生产循环跑完所有档 → reject。
    return 'data:image/jpeg;base64,' + 'A'.repeat(7 * 1024 * 1024);
  }) as unknown as typeof HTMLCanvasElement.prototype.toDataURL);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 让 FakeFileReader 对所有 mime 返指定长度（> MAX_BASE64_BYTES_FOR_API）大 base64。 */
function setMockBigBase64(charLen: number): void {
  mockHooks.bigBase64 = 'A'.repeat(charLen);
}

/** 让 QueuedImage 触发 onerror 而非 onload（覆盖 makeThumbnail img.onerror 分支）。 */
function setMockImageFail(fail: boolean): void {
  mockHooks.failImage = fail;
}

/**
 * 让 canvas.toDataURL 按调用次序返回不同长度的 base64 字符串（模拟 COMPRESS_ATTEMPTS 降档）。
 *   - {size: N} → 第 N 次 toDataURL 调用返回该长度的 base64
 *   - 数组长度可 < 7（不够 7 档时剩余档走越界兜底 → 全超 MAX → reject）
 */
function setMockCompressLengths(lengths: Array<{ size: number } | 'no-ctx'>): void {
  mockHooks.compressLengths = lengths;
}

function png(name: string, size = 1000): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

/**
 * 构造一个「文件头是 animated WebP（VP8X + ANIM bit）」的 webp File。
 * detectAnimatedWebp 读 file.slice(0,32).arrayBuffer() 检测 ANIM bit → 返 true。
 * 注：FileReader mock 对 webp 返回超阈值大 dataUrl（驱动 add() preflight 的 base64 长度闸门），
 * 与本 helper 的真实 bytes 正交 —— base64 大小由 FileReader mock 控、animated 判定由真实 bytes 控。
 */
function animatedWebpFile(name = 'anim.webp'): File {
  const head = new Uint8Array(64);
  head.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  head.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  head.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  head[20] = 0x02; // ANIM flag bit
  return new File([head], name, { type: 'image/webp' });
}

/** settle 当前所有 micro/macrotask（推进 add 的 for 循环到下一个 Image 卡点）。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 触发队首 Image.onload + settle（让卡在该 thumb 的那张图完成 push，for 推进到下一张）。 */
async function flushOneImage(): Promise<void> {
  await act(async () => {
    imageOnloadQueue.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('useImageAttachments — 基础路径', () => {
  it('add 一张小 png → attachments 出现一条（mime/name 正确）', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    const p = hook.current.add([png('a.png')]);
    await settle(); // FileReader 完成 → 卡在 thumb Image
    await flushOneImage(); // thumb 完成 → push
    await act(async () => {
      await p;
    });
    expect(hook.current.attachments).toHaveLength(1);
    expect(hook.current.attachments[0]).toMatchObject({ mime: 'image/png', name: 'a.png' });
    expect(hook.current.error).toBeNull();
  });

  it('非白名单 mime（如 image/bmp）→ 拒绝 + error，不入列', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    const bmp = new File([new Uint8Array(10)], 'x.bmp', { type: 'image/bmp' });
    await act(async () => {
      await hook.current.add([bmp]);
    });
    expect(hook.current.attachments).toHaveLength(0);
    expect(hook.current.error).toContain('仅支持');
  });
});

describe('useImageAttachments — oversized animated WebP preflight', () => {
  it('超阈值 animated webp → preflight 拒 + error，且 thumbnail 未启动（imageOnloadQueue 空）', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    await act(async () => {
      await hook.current.add([animatedWebpFile()]);
    });
    expect(hook.current.attachments).toHaveLength(0);
    expect(hook.current.error).toContain('webp 动图');
    // Preflight rejects before thumbnail decoding starts.
    expect(imageOnloadQueue).toHaveLength(0);
  });
});

describe('useImageAttachments — remove preserves sibling in-flight work', () => {
  it('多图批量上传，删第一张（已入列）→ 仍 in-flight 的 B/C 不被丢弃', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());

    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('A'), png('B'), png('C')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // A 还没 push（卡在 A 的 thumb Image），队列只有 A_img
    expect(hook.current.attachments).toHaveLength(0);
    expect(imageOnloadQueue).toHaveLength(1);

    // flush A_img → A push，for 推进到 B（卡 B 的 thumb Image）
    await flushOneImage();
    expect(hook.current.attachments.map((a) => a.name)).toEqual(['A']);
    const aId = hook.current.attachments[0].id;

    // ★ 此刻 B/C 仍 in-flight（B 卡 Image，C 还没轮到）。用户删 A
    act(() => hook.current.remove(aId));
    expect(hook.current.attachments).toHaveLength(0); // A 已移除

    // B and C still complete after A is removed.
    await flushOneImage();
    await flushOneImage();
    await act(async () => {
      await addDone;
    });

    expect(hook.current.attachments.map((a) => a.name)).toEqual(['B', 'C']);
    expect(hook.current.error).toBeNull(); // 连坐丢弃是「静默 continue 无 error」，这里确认无误报也无丢弃
  });

  it('删 in-flight 期间的某张已入列图，剩余兄弟数量正确（删中间 B，A/C 保留）', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('A'), png('B'), png('C')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushOneImage(); // A push
    await flushOneImage(); // B push（C 仍 in-flight）
    expect(hook.current.attachments.map((a) => a.name)).toEqual(['A', 'B']);

    // C 仍 in-flight 时删 B
    const bId = hook.current.attachments.find((a) => a.name === 'B')!.id;
    act(() => hook.current.remove(bId));

    await flushOneImage(); // C push —— 不被连坐
    await act(async () => {
      await addDone;
    });
    expect(hook.current.attachments.map((a) => a.name)).toEqual(['A', 'C']);
  });
});

describe('useImageAttachments — clear/unmount 整批取消（generation bump 正确语义）', () => {
  it('clear() 期间的 in-flight 图被整批丢弃（A 已入列也被清，B 在飞被丢）', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('A'), png('B')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushOneImage(); // A push（B 仍 in-flight）
    expect(hook.current.attachments.map((a) => a.name)).toEqual(['A']);

    // clear() bump generation → 清空已入列 + 让 in-flight B 在 resolve 后 generation 失配被丢弃
    act(() => hook.current.clear());
    expect(hook.current.attachments).toHaveLength(0);

    await flushOneImage(); // B 的 thumb 完成，但 generation 已失配 → 静默丢弃
    await act(async () => {
      await addDone;
    });
    expect(hook.current.attachments).toHaveLength(0); // B 没复活
  });

  // A cleared generation must also reject a late attachment error.
  it('clear() 期间失配的 add 即使有 error 也不回灌（setError generation 守卫）', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    const badMime = new File([new Uint8Array(10)], 'x.bmp', { type: 'image/bmp' });
    let addDone!: Promise<boolean>;
    await act(async () => {
      // bad-mime 同步 push error + continue（不入 imageOnloadQueue）；good-png 走 await 卡 thumb
      addDone = hook.current.add([badMime, png('good')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // good 仍 in-flight（卡 thumb Image），add 还没走到末尾的 setError
    expect(imageOnloadQueue).toHaveLength(1);

    // clear() bump generation → add 末尾的 setError 检查将失配
    act(() => hook.current.clear());

    await flushOneImage(); // good 的 thumb 完成 → generation 失配丢弃 → 走到 add 末尾 setError 检查
    await act(async () => {
      await addDone;
    });
    // 守卫生效：generation 失配 → 不 setError，clear 后 error 保持 null（未被 bad-mime 的 stale error 污染）
    expect(hook.current.error).toBeNull();
    expect(hook.current.attachments).toHaveLength(0);
  });

  // Post-unmount work must settle without hanging or throwing.
  it('post-unmount：in-flight 图 resolve 能 settle（不 hang / 不抛错，smoke）', async () => {
    const { result: hook, unmount } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('A')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // A 仍 in-flight 时 unmount，随后触发 A 的 thumb resolve
    unmount();
    let settled = false;
    await act(async () => {
      imageOnloadQueue.shift()?.();
      await addDone; // 不 hang（能 resolve）+ 不 reject（await 不抛）
      settled = true;
    });
    expect(settled).toBe(true);
  });
});

describe('useImageAttachments — logical session isolation', () => {
  it('an add finishing after A→B updates only A and is restored when returning', async () => {
    const { result: hook, rerender } = renderHook(
      ({ sessionId }) => useImageAttachments(sessionId),
      { initialProps: { sessionId: 'session-A' } },
    );
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('A.png')]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    rerender({ sessionId: 'session-B' });
    expect(hook.current.attachments).toHaveLength(0);

    await flushOneImage();
    await act(async () => {
      await addDone;
    });
    expect(hook.current.attachments).toHaveLength(0);

    rerender({ sessionId: 'session-A' });
    expect(hook.current.attachments.map((item) => item.name)).toEqual(['A.png']);
  });

  it('a stale add failure stays on its originating session', async () => {
    setMockBigBase64(6 * 1024 * 1024);
    const oversize = { size: MAX_BASE64_BYTES_FOR_API + 100 };
    setMockCompressLengths([
      oversize, oversize, oversize, oversize, oversize, oversize, oversize,
    ]);
    const { result: hook, rerender } = renderHook(
      ({ sessionId }) => useImageAttachments(sessionId),
      { initialProps: { sessionId: 'session-A' } },
    );
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('huge-A.png', 5 * 1024 * 1024)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    rerender({ sessionId: 'session-B' });
    await flushOneImage();
    await flushOneImage();
    await act(async () => {
      await addDone;
    });
    expect(hook.current.error).toBeNull();

    rerender({ sessionId: 'session-A' });
    expect(hook.current.error).toContain('即使最低质量');
  });
});

describe('useImageAttachments — removing a missing id is a no-op', () => {
  it('remove 一个还在 in-flight（尚无 id）的图是 no-op，该图 resolve 后正常入列', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('M')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    // M 仍在压缩/缩略（id 在 await 之后才 nextId 生成）→ UI 列表里没有 M，用户点不到「删」它。
    // 模拟「试图删一个不存在的 id」：no-op（不 bump generation、不影响 M 入列）
    act(() => hook.current.remove('att-nonexistent-999'));

    await flushOneImage(); // M 的 thumb 完成 → 正常 push
    await act(async () => {
      await addDone;
    });
    expect(hook.current.attachments.map((a) => a.name)).toEqual(['M']); // M 正常入列，未被误删
  });
});

describe('useImageAttachments — makeThumbnail img.onerror 安全回退', () => {
  it('缩略图 Image decode 失败 → 使用 blob URL，完整 base64 不进入 React state', async () => {
    setMockImageFail(true);
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('broken.png')]);
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushOneImage();
    await act(async () => {
      await addDone;
    });
    expect(hook.current.attachments).toHaveLength(1);
    expect(hook.current.attachments[0].name).toBe('broken.png');
    expect(hook.current.attachments[0].thumbnailDataUrl).toMatch(/^blob:/);
    expect(hook.current.attachments[0].thumbnailDataUrl).not.toContain('aGVsbG8=');
    // Thumbnail decode failure does not change the original payload MIME.
    expect(hook.current.attachments[0].mime).toBe('image/png');
    expect(hook.current.error).toBeNull(); // onerror 不抛错，error 不应被设
  });
});

describe('useImageAttachments — oversized image JPEG compression attempts', () => {
  it('大图 base64 > 阈值 → 走 canvas 重编码 JPEG，前 3 档 oversize + 第 4 档命中 → mime 变 jpeg + entry 正常入列', async () => {
    // 配 7 档逐档长度：前 3 档 oversize（> MAX），第 4 档 fits（< MAX），后 3 档不再被调
    // （循环命中 return）。不配够 7 档不影响 — 命中即 return。
    setMockBigBase64(6 * 1024 * 1024); // 6MB chars, base64 length 远 > MAX_BASE64_BYTES_FOR_API
    setMockCompressLengths([
      { size: MAX_BASE64_BYTES_FOR_API + 100 }, // 档 1 oversize
      { size: MAX_BASE64_BYTES_FOR_API + 100 }, // 档 2 oversize
      { size: MAX_BASE64_BYTES_FOR_API + 100 }, // 档 3 oversize
      { size: MAX_BASE64_BYTES_FOR_API - 1000 }, // 档 4 命中（< MAX）
    ]);
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('big.png', 5 * 1024 * 1024)]); // 5MB raw → 必然超 base64 阈值
      await new Promise((r) => setTimeout(r, 0));
    });
    // Compression and thumbnail decoding each enqueue one Image.
    expect(imageOnloadQueue).toHaveLength(2);
    await flushOneImage(); // ① 压缩 Image decode 完成
    await flushOneImage(); // ② thumb Image 完成
    await act(async () => {
      await addDone;
    });
    // Successful compression emits a JPEG attachment.
    expect(hook.current.attachments).toHaveLength(1);
    expect(hook.current.attachments[0].mime).toBe('image/jpeg');
    // Compressed entries retain the original size for user feedback.
    expect(hook.current.attachments[0].originalBytes).toBe(5 * 1024 * 1024);
    // Bytes reflect the decoded JPEG payload.
    const expectedBytes = Math.floor((MAX_BASE64_BYTES_FOR_API - 1000) * 3) / 4;
    expect(hook.current.attachments[0].bytes).toBe(Math.floor(expectedBytes));
    expect(hook.current.error).toBeNull();
    // toDataURL 至少被调过 4 次（前 3 档 oversize + 第 4 档命中，命中后循环 return）
    expect(
      (HTMLCanvasElement.prototype.toDataURL as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('大图走 7 档全 oversize → reject 让 UI 报错（catch → setError），不入列', async () => {
    setMockBigBase64(6 * 1024 * 1024);
    // 7 档全 oversize（lengths 数组配 7 个，命中阈值仍 > MAX）→ 循环跑完 reject
    const allOversize = { size: MAX_BASE64_BYTES_FOR_API + 100 };
    setMockCompressLengths([
      allOversize, allOversize, allOversize, allOversize, allOversize, allOversize, allOversize,
    ]);
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('huge.png', 5 * 1024 * 1024)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(imageOnloadQueue).toHaveLength(2); // 压缩 Image + thumb Image
    await flushOneImage();
    await flushOneImage();
    await act(async () => {
      await addDone;
    });
    // catch 路径：error 含「即使最低质量」+ 不入列
    expect(hook.current.attachments).toHaveLength(0);
    expect(hook.current.error).toContain('即使最低质量');
  });

  it('skips an attempt without a canvas context and continues compression', async () => {
    setMockBigBase64(6 * 1024 * 1024);
    setMockCompressLengths(['no-ctx', { size: MAX_BASE64_BYTES_FOR_API - 1000 }]);
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<boolean>;
    await act(async () => {
      addDone = hook.current.add([png('noctx.png', 5 * 1024 * 1024)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(imageOnloadQueue).toHaveLength(2);
    await flushOneImage();
    await flushOneImage();
    await act(async () => {
      await addDone;
    });
    // 跳过 no-ctx 档 → 第 2 档命中 → 正常入列 jpeg
    expect(hook.current.attachments).toHaveLength(1);
    expect(hook.current.attachments[0].mime).toBe('image/jpeg');
    expect(hook.current.error).toBeNull();
  });
});

describe('useImageAttachments — GIF size handling', () => {
  it('gif + base64 长度 > MAX → reject 「gif 动图」+ 不入列 + imageOnloadQueue 空', async () => {
    // gif 大 base64 → Path 2 命中（gif 跳过 makeThumbnail 第一个分支直接 return fullDataUrl，不 new Image）
    setMockBigBase64(6 * 1024 * 1024);
    const gif = new File([new Uint8Array(5 * 1024 * 1024)], 'anim.gif', { type: 'image/gif' });
    const { result: hook } = renderHook(() => useImageAttachments());
    await act(async () => {
      await hook.current.add([gif]);
    });
    expect(hook.current.error).toContain('gif 动图');
    expect(hook.current.error).toContain('无法自动压缩');
    expect(hook.current.attachments).toHaveLength(0);
    // GIF previews do not rasterize an animation through canvas.
    expect(imageOnloadQueue).toHaveLength(0);
  });

  it('gif + base64 长度 ≤ MAX → 走 Path 1 正常入列（小动图无需压缩）', async () => {
    // 小 gif → Path 1 命中（base64 length <= MAX）→ 正常入列；makeThumbnail 仍走
    // mime==='image/gif' 分支直接返 fullDataUrl，不 new Image。
    const smallGif = new File([new Uint8Array(100)], 'small.gif', { type: 'image/gif' });
    const { result: hook } = renderHook(() => useImageAttachments());
    await act(async () => {
      await hook.current.add([smallGif]);
    });
    // 小 gif：默认 FakeFileReader 返 'data:image/png;base64,aGVsbG8='（非 webp → 走小 base64 分支）
    // → base64 length 远 < MAX → Path 1 命中
    expect(hook.current.attachments).toHaveLength(1);
    expect(hook.current.attachments[0].name).toBe('small.gif');
    expect(hook.current.attachments[0].mime).toBe('image/gif');
    // 动图缩略图走 blob URL，保留动画且不把完整 base64 放进 React state。
    expect(hook.current.attachments[0].thumbnailDataUrl).toMatch(/^blob:/);
    expect(hook.current.error).toBeNull();
    expect(imageOnloadQueue).toHaveLength(0); // gif 永远不进 imageOnloadQueue
  });
});
