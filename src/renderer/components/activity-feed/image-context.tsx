import { createContext } from 'react';
import type { ImageSource, LoadImageBlobResult } from '@shared/types';
import { createImageBlobCache } from '@renderer/hooks/useImageBlob';

export interface ActivityImageReader {
  identity: string;
  load(sessionId: string, source: ImageSource): Promise<LoadImageBlobResult>;
}
export const LOCAL_ACTIVITY_IMAGES: ActivityImageReader = {
  identity: 'local',
  load: (sessionId, source) => window.api.loadImageBlob(sessionId, source),
};
export const ActivityImageContext = createContext<ActivityImageReader | null>(null);
export const eventImageBlobCache = createImageBlobCache();
