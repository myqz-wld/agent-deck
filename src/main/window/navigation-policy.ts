import type { WebContents } from 'electron';
import log from '@main/utils/logger';

const logger = log.scope('window-lifecycle');
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

type NavigationWebContents = Pick<WebContents, 'on' | 'setWindowOpenHandler'>;
type ExternalOpener = (url: string) => Promise<unknown>;

export function allowedExternalNavigationUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function openAllowedExternal(rawUrl: string, openExternal: ExternalOpener): void {
  const externalUrl = allowedExternalNavigationUrl(rawUrl);
  if (!externalUrl) return;
  void openExternal(externalUrl).catch((error: unknown) => {
    logger.warn('[window] external navigation failed', {
      protocol: new URL(externalUrl).protocol,
      errorName: error instanceof Error ? error.name : 'unknown-error',
    });
  });
}

/** Keep links and source-location clicks from replacing the single application renderer. */
export function installWindowNavigationPolicy(
  webContents: NavigationWebContents,
  openExternal: ExternalOpener,
): void {
  webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openAllowedExternal(url, openExternal);
  });
  webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url, openExternal);
    return { action: 'deny' };
  });
}
