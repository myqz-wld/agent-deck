/**
 * Ambient declarations for Vite query suffix imports used in main process.
 *
 * `?raw` lets us inline file contents (e.g. SQL migrations) into the bundled
 * main JS at build time, avoiding runtime fs.readFileSync + asar path issues
 * (CHANGELOG_15 ENOTDIR教训).
 *
 * vite/client.d.ts (renderer) declares this globally for renderer code, but main
 * process uses electron-vite/node types which don't include browser-side suffixes.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
