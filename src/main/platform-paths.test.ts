import { describe, expect, it } from 'vitest';

import { isPathWithinRoot, isPlatformAbsolutePath } from './platform-paths';

describe('platform path classification', () => {
  it('keeps POSIX absolute-path classification host-independent', () => {
    expect(isPlatformAbsolutePath('/workspace/image.png', 'linux')).toBe(true);
    expect(isPlatformAbsolutePath('workspace/image.png', 'linux')).toBe(false);
    expect(isPlatformAbsolutePath('C:\\workspace\\image.png', 'linux')).toBe(false);
  });

  it('accepts Windows drive-letter and UNC absolute paths', () => {
    expect(isPlatformAbsolutePath('C:\\workspace\\image.png', 'win32')).toBe(true);
    expect(isPlatformAbsolutePath('d:/workspace/image.png', 'win32')).toBe(true);
    expect(isPlatformAbsolutePath('\\\\server\\share\\image.png', 'win32')).toBe(true);
    expect(isPlatformAbsolutePath('C:workspace\\image.png', 'win32')).toBe(false);
  });

  it('enforces separator-bound POSIX containment', () => {
    expect(isPathWithinRoot('/uploads', '/uploads/image.png', 'linux')).toBe(true);
    expect(isPathWithinRoot('/uploads', '/uploads-nbr/image.png', 'linux')).toBe(false);
    expect(isPathWithinRoot('/uploads', '/outside/image.png', 'linux')).toBe(false);
    expect(isPathWithinRoot('/uploads', '/uploads', 'linux')).toBe(false);
  });

  it('enforces drive and UNC root containment with Windows semantics', () => {
    expect(isPathWithinRoot('C:\\Uploads', 'c:\\uploads\\nested\\image.png', 'win32')).toBe(true);
    expect(isPathWithinRoot('C:\\Uploads', 'C:\\Uploads-neighbor\\image.png', 'win32')).toBe(false);
    expect(isPathWithinRoot('C:\\Uploads', 'D:\\Uploads\\image.png', 'win32')).toBe(false);
    expect(isPathWithinRoot(
      '\\\\server\\share\\uploads',
      '\\\\server\\share\\uploads\\image.png',
      'win32',
    )).toBe(true);
  });
});
