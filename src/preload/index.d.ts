import type { AgentDeckApi } from './index';

declare global {
  interface Window {
    api: AgentDeckApi;
  }
}

export {};
