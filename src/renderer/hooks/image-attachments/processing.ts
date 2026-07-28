const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_BYTES_PER_IMAGE = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_BASE64_BYTES_FOR_API = 5 * 1024 * 1024 - 200 * 1024;
const THUMB_MAX_DIM = 200;
const EMPTY_THUMBNAIL =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

const COMPRESS_ATTEMPTS = [
  { scale: 1, quality: 0.85 },
  { scale: 1, quality: 0.7 },
  { scale: 1, quality: 0.55 },
  { scale: 0.7, quality: 0.7 },
  { scale: 0.7, quality: 0.55 },
  { scale: 0.5, quality: 0.7 },
  { scale: 0.5, quality: 0.55 },
];

export interface ProcessedImage {
  thumbnailDataUrl: string;
  mime: string;
  bytes: number;
  base64: string;
  name?: string;
  originalBytes?: number;
  disposePreview?: () => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('readAsDataURL failed'));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('reader result not string'));
    };
    reader.readAsDataURL(file);
  });
}

function stripDataUrlPrefix(dataUrl: string): string {
  const index = dataUrl.indexOf(',');
  if (index < 0) throw new Error('dataUrl missing comma');
  return dataUrl.slice(index + 1);
}

function base64ByteLength(base64: string): number {
  if (base64.length === 0) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = dataUrl;
  });
}

export function isAnimatedWebpHeader(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  if (head[0] !== 0x52 || head[1] !== 0x49 || head[2] !== 0x46 || head[3] !== 0x46) return false;
  if (head[8] !== 0x57 || head[9] !== 0x45 || head[10] !== 0x42 || head[11] !== 0x50) return false;
  if (head[12] !== 0x56 || head[13] !== 0x50 || head[14] !== 0x38 || head[15] !== 0x58) return false;
  return (head[20] & 0x02) !== 0;
}

export async function detectAnimatedWebp(file: File): Promise<boolean> {
  try {
    return isAnimatedWebpHeader(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  } catch {
    return false;
  }
}

function encodeJpeg(
  image: HTMLImageElement,
  scale: number,
  quality: number,
): { base64: string; bytes: number } | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    const base64 = stripDataUrlPrefix(canvas.toDataURL('image/jpeg', quality));
    return { base64, bytes: base64ByteLength(base64) };
  } catch {
    return null;
  }
}

async function compress(
  file: File,
  mime: string,
  dataUrl: string,
): Promise<{ base64: string; mime: string; bytes: number; compressed: boolean }> {
  const original = stripDataUrlPrefix(dataUrl);
  if (original.length <= MAX_BASE64_BYTES_FOR_API) {
    return { base64: original, mime, bytes: file.size, compressed: false };
  }
  if (mime === 'image/gif') {
    throw new Error(
      `gif 动图 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 API 5MB base64 上限，无法自动压缩（压会丢动）。请手动转静图或缩小尺寸`,
    );
  }
  if (mime === 'image/webp' && (await detectAnimatedWebp(file))) {
    throw new Error(
      `webp 动图 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 API 5MB base64 上限，无法自动压缩（压会丢动）。请手动转静图或缩小尺寸`,
    );
  }
  const image = await loadImage(dataUrl);
  for (const attempt of COMPRESS_ATTEMPTS) {
    const output = encodeJpeg(image, attempt.scale, attempt.quality);
    if (output && output.base64.length <= MAX_BASE64_BYTES_FOR_API) {
      return { ...output, mime: 'image/jpeg', compressed: true };
    }
  }
  throw new Error(
    `图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 即使最低质量 + 50% 缩放仍超过 API 5MB 上限。请手动裁剪或更换图片`,
  );
}

function blobPreview(file: File): {
  thumbnailDataUrl: string;
  disposePreview?: () => void;
} {
  if (typeof URL.createObjectURL !== 'function') return { thumbnailDataUrl: EMPTY_THUMBNAIL };
  const url = URL.createObjectURL(file);
  return {
    thumbnailDataUrl: url,
    disposePreview: () => URL.revokeObjectURL(url),
  };
}

function makeThumbnail(
  file: File,
  mime: string,
  fullDataUrl: string,
): Promise<{ thumbnailDataUrl: string; disposePreview?: () => void }> {
  if (mime === 'image/gif') return Promise.resolve(blobPreview(file));
  return new Promise((resolve) => {
    const image = new Image();
    image.onerror = () => resolve(blobPreview(file));
    image.onload = () => {
      const ratio = Math.min(THUMB_MAX_DIM / image.width, THUMB_MAX_DIM / image.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(blobPreview(file));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'source-over';
      try {
        resolve({ thumbnailDataUrl: canvas.toDataURL('image/jpeg', 0.7) });
      } catch {
        resolve(blobPreview(file));
      }
    };
    image.src = fullDataUrl;
  });
}

export function validateImageFile(file: File): string | null {
  if (!ALLOWED_MIMES.has(file.type)) return '仅支持 PNG / JPEG / GIF / WebP';
  if (file.size > MAX_BYTES_PER_IMAGE) {
    return `单图 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_BYTES_PER_IMAGE / 1024 / 1024}MB 上限`;
  }
  return null;
}

export async function processImageFile(file: File): Promise<ProcessedImage> {
  const dataUrl = await readFileAsDataUrl(file);
  if (
    file.type === 'image/webp'
    && stripDataUrlPrefix(dataUrl).length > MAX_BASE64_BYTES_FOR_API
    && await detectAnimatedWebp(file)
  ) {
    throw new Error(
      `webp 动图 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 API 5MB base64 上限，无法自动压缩（压会丢动）。请手动转静图或缩小尺寸`,
    );
  }
  const [compressedResult, thumbnailResult] = await Promise.allSettled([
    compress(file, file.type, dataUrl),
    makeThumbnail(file, file.type, dataUrl),
  ]);
  if (compressedResult.status === 'rejected') {
    if (thumbnailResult.status === 'fulfilled') thumbnailResult.value.disposePreview?.();
    throw compressedResult.reason;
  }
  if (thumbnailResult.status === 'rejected') throw thumbnailResult.reason;
  const compressed = compressedResult.value;
  const thumbnail = thumbnailResult.value;
  return {
    ...thumbnail,
    base64: compressed.base64,
    mime: compressed.mime,
    bytes: compressed.bytes,
    name: file.name,
    ...(compressed.compressed ? { originalBytes: file.size } : {}),
  };
}
