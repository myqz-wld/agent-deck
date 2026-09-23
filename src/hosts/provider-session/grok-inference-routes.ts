import type { ProviderInferenceRoute } from '@contracts/index';

/** Exact operations permitted through the credential-isolating Grok broker. */
export const GROK_INFERENCE_ROUTES = Object.freeze([
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/responses' },
  { method: 'GET', path: '/v1/models' },
] as const satisfies readonly ProviderInferenceRoute[]);
