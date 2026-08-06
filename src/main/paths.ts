/**
 * userData 子路径集中点。
 *
 * Electron and headless hosts install one exact process path identity. Consumers derive only their
 * owned child paths and never consult Electron or launch cwd.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getApplicationHostPaths,
  type ApplicationHostPaths,
} from '@main/runtime-host/application-paths';

export function resolveImageUploadsDir(paths: ApplicationHostPaths): string {
  return join(paths.userDataPath, 'image-uploads');
}

/** 用户上传图片的扁平根目录：<userData>/image-uploads/<uuid>.<ext> */
export function getImageUploadsDir(): string {
  return resolveImageUploadsDir(getApplicationHostPaths());
}

export function resolveProviderUsageProbeCwd(paths: ApplicationHostPaths): string {
  return join(paths.userDataPath, 'provider-usage-probe-cwd');
}

/**
 * Provider quota probes must not inherit Electron's launch cwd. In packaged
 * macOS apps that can be `/` or a user-protected folder such as Downloads,
 * which may trigger TCC prompts or create confusing Claude hook sessions.
 */
export function getProviderUsageProbeCwd(): string {
  const dir = resolveProviderUsageProbeCwd(getApplicationHostPaths());
  mkdirSync(dir, { recursive: true });
  return dir;
}
