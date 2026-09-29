import { createContext } from 'react';
import type { FileChangeReader } from '../diff/file-change-reader';

export const ActivityFileChangeContext = createContext<FileChangeReader | null>(null);
