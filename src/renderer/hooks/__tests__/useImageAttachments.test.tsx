// @vitest-environment jsdom
/**
 * useImageAttachments hook 异步 race 回归测试（REVIEW_102 follow-up，issue 6f86ac86）。
 *
 * 背景：REVIEW_102 R2 双 reviewer 独立命中 INFO —— 本轮风险最高的 MED-1 generationRef 批级
 * 语义仅靠 /tmp sim 实证（/tmp/img-med1-fix.mjs 3 场景），未落 repo committed test。用户拍板
 * 方案 (a)：jsdom + renderHook 直测真实 hook。spike1-jsdom-rtl-compat.md 验证可行 + spike2 经
 * mutation test 证明能挡回归（插回 remove() 旧 bump bug → 本文件 MED-1 测试变红）。
 *
 * 覆盖 MED-1（claude 单方 + lead sim 复现 + 复活不可达铁证）：
 *   remove() 不 bump generationRef → 多图批量上传删任一张时，同批仍 in-flight 的兄弟不被
 *   连坐静默丢弃；clear()/unmount 的整批取消 bump 保留（那才是丢弃所有 in-flight 的正确语义）。
 *
 * ── mock 策略（jsdom 不实现 FileReader 行为 / Image decode / canvas）──
 * - FileReader.readAsDataURL → microtask 自动 onload 返回小 dataUrl（base64 远 < 压缩阈值，
 *   故 readAndMaybeCompress 走 Path1 同步返回，不碰 Image）。
 * - Image.onload **不自动触发**，进 imageOnloadQueue 手动队列 —— 唯一异步卡点是 makeThumbnail
 *   的 `new Image()`，逐个 flush 即可精确控制每张图的 push 时机，构造「A 已入列、B/C 仍 in-flight」。
 * - canvas getContext/toDataURL spyOn（缩略图编码）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useImageAttachments } from '../useImageAttachments';

let imageOnloadQueue: Array<() => void> = [];

beforeEach(() => {
  imageOnloadQueue = [];

  class FakeFileReader {
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(file: Blob): void {
      // webp 返回超 API base64 阈值的大 dataUrl（驱动 add() 的 animated-webp preflight 分支，
      // REVIEW_111 补强）；其余（png 等）返回小 base64（< MAX_BASE64_BYTES_FOR_API）→
      // readAndMaybeCompress 走 Path1 直接返回不碰压缩 Image。
      const type = (file as File).type;
      this.result =
        type === 'image/webp'
          ? 'data:image/webp;base64,' + 'A'.repeat(5 * 1024 * 1024)
          : 'data:image/png;base64,aGVsbG8=';
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
      imageOnloadQueue.push(() => this.onload?.());
    }
    get src(): string {
      return this._src;
    }
  }
  vi.stubGlobal('Image', QueuedImage as unknown as typeof Image);

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    globalCompositeOperation: '',
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,dGh1bWI=');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe('useImageAttachments — REVIEW_102 R2 LOW：oversize animated webp preflight', () => {
  // R2 LOW（reviewer-codex 单方 + lead sim）：oversize animated webp 在 add() 的 Promise.all
  // **之前** 被 preflight 拒（detectAnimatedWebp 命中 → throw），makeThumbnail 不被启动 →
  // 不产生无用的整图 decode/canvas 峰值。区分性断言 = imageOnloadQueue 为空（旧版靠
  // readAndMaybeCompress Path2.5 拒则 Promise.all 已先启动 makeThumbnail → 队列有 1 个）。
  it('超阈值 animated webp → preflight 拒 + error，且 thumbnail 未启动（imageOnloadQueue 空）', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    await act(async () => {
      await hook.current.add([animatedWebpFile()]);
    });
    expect(hook.current.attachments).toHaveLength(0);
    expect(hook.current.error).toContain('webp 动图');
    // ★ preflight 在 Promise.all 之前 throw → makeThumbnail 从未被调用 → 无 Image 入队
    expect(imageOnloadQueue).toHaveLength(0);
  });
});

describe('useImageAttachments — MED-1：remove 不连坐同批 in-flight 兄弟', () => {
  it('多图批量上传，删第一张（已入列）→ 仍 in-flight 的 B/C 不被丢弃', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());

    let addDone!: Promise<void>;
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

    // flush B_img + C_img → B、C 完成 push（MED-1 修法：不被 remove(A) 的 generation bump 连坐）
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
    let addDone!: Promise<void>;
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
    let addDone!: Promise<void>;
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

  // claude INFO #4：setError 的 generation 守卫（useImageAttachments.ts:442）—— add 末尾写
  // error 前检查 generation，clear() 期间（generation 失配）的 add 即使攒了 errors 也不该污染
  // 新一批 UI。构造混批 [bad-mime（同步攒 error）, good-png（await 卡点）]，await 期间 clear()，
  // 断言 clear 后 error 仍为 null（守卫拦住了 stale error 回灌）。
  it('clear() 期间失配的 add 即使有 error 也不回灌（setError generation 守卫）', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    const badMime = new File([new Uint8Array(10)], 'x.bmp', { type: 'image/bmp' });
    let addDone!: Promise<void>;
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

  // REVIEW_111 MED（reviewer-claude 单方 + mutation 实证）：原版断言 `expect(true).toBe(true)`
  // 是假绿 —— React 19 对 unmounted setState 静默 no-op，「不抛错」恒成立与守卫无关；reviewer
  // mutation 把生产 mountedRef 守卫置死该测试仍绿。根因：unmount 后组件销毁、无可观测 state，
  // 且 mountedRef 与 cleanup 的 generation bump（useImageAttachments.ts:346）冗余，结构上无法
  // 对 mountedRef 做区分性覆盖。故诚实降级为 smoke test：只验「post-unmount add() resolve 能
  // settle（不 hang）、不抛错」——不声称覆盖守卫本身（守卫行为价值由 clear() 测试经 mutation
  // 担保 —— 置死守卫 → clear 测试变红）。
  //
  // REVIEW_111 R2 INFO（reviewer-claude）：原先还断言过 `console.error` 无 'unmounted' React
  // warning，但 React 19.2.5 已删该 warning（grep node_modules/react-dom 零命中）→ 该子断言恒
  // 空（vacuous）无论守卫在不在都绿。删掉避免「无害死重」误导读者以为守卫被测；只留 settle 这
  // 个有边际价值的断言（未来若有人在 post-unmount resolve 路径加裸 deref 抛错会被它抓）。
  it('post-unmount：in-flight 图 resolve 能 settle（不 hang / 不抛错，smoke）', async () => {
    const { result: hook, unmount } = renderHook(() => useImageAttachments());
    let addDone!: Promise<void>;
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

describe('useImageAttachments — 复活场景不可达（MED-1 铁证）', () => {
  it('remove 一个还在 in-flight（尚无 id）的图是 no-op，该图 resolve 后正常入列', async () => {
    const { result: hook } = renderHook(() => useImageAttachments());
    let addDone!: Promise<void>;
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
