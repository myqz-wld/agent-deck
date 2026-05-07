/**
 * userData 子路径集中点。
 *
 * 现状只有少数模块直接调 `app.getPath('userData')`（db.ts:12 / sdk-injection.ts:86）。
 * 新加的 image-uploads 目录从一开始就走集中点，避免散落字符串拼接。
 *
 * 不主动迁移现有调用方（性价比低、有测试覆盖的别动）。
 */
import { app } from 'electron';
import { join } from 'node:path';

/** 用户上传图片的扁平根目录：<userData>/image-uploads/<uuid>.<ext> */
export function getImageUploadsDir(): string {
  return join(app.getPath('userData'), 'image-uploads');
}
