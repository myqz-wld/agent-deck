/**
 * Provider quota snapshot refresh policy shared by main and renderer.
 *
 * The renderer schedules background refreshes; the main process keeps a TTL
 * cache slightly shorter than that interval so each scheduled tick can refresh
 * while nearby Data tab opens reuse the same snapshot.
 */
export const PROVIDER_USAGE_REFETCH_MS = 10 * 60_000;
export const PROVIDER_USAGE_CACHE_TTL_GRACE_MS = 5_000;
export const PROVIDER_USAGE_CACHE_TTL_MS =
  PROVIDER_USAGE_REFETCH_MS - PROVIDER_USAGE_CACHE_TTL_GRACE_MS;
