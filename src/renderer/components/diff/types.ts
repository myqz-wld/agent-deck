import type { ComponentType } from 'react';
import type { DiffPayload } from '@shared/types';

export interface DiffRendererProps<T = unknown> {
  payload: DiffPayload<T>;
}

export interface DiffRendererPlugin<T = unknown> {
  kind: string;
  priority?: number;
  canHandle: (payload: DiffPayload) => boolean;
  Component: ComponentType<DiffRendererProps<T>>;
}
