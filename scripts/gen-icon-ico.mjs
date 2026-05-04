#!/usr/bin/env node
/**
 * 把 resources/icon.png 转成 resources/icon.ico（Win 打包用）。
 *
 * png-to-ico 默认产出 16/24/32/48/64/96/128/256 多尺寸合一的 .ico；
 * Win Explorer / NSIS 安装器会自动按场景挑合适尺寸。
 *
 * 用法：node scripts/gen-icon-ico.mjs
 *      （或 pnpm icon:gen）
 *
 * 何时跑：
 *   - 第一次 setup Win 打包（已跑过，icon.ico 已 commit）
 *   - resources/icon.png 改了之后手动跑一次重生成
 *   - CI 出包前可选作为 build 前置步骤
 */
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');
const src = resolve(repoRoot, 'resources/icon.png');
const dst = resolve(repoRoot, 'resources/icon.ico');

const buf = await pngToIco(src);
writeFileSync(dst, buf);
console.log(`[icon] generated ${dst} (${buf.length} bytes) from ${src}`);
