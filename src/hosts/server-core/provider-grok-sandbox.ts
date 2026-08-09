export const SERVER_CORE_GROK_CONTAINER_SANDBOXES = Object.freeze([
  'strict',
  'read-only',
  'workspace',
  'off',
] as const);

export type ServerCoreGrokContainerSandbox =
  (typeof SERVER_CORE_GROK_CONTAINER_SANDBOXES)[number];

/** The container boundary accepts only fixed profiles with an exact Workspace access mapping. */
export function serverCoreGrokSandbox(
  requested: string | null | undefined,
): ServerCoreGrokContainerSandbox {
  if (!SERVER_CORE_GROK_CONTAINER_SANDBOXES.includes(
    requested as ServerCoreGrokContainerSandbox,
  )) {
    throw new Error('Remote Grok sandbox is unavailable');
  }
  return requested as ServerCoreGrokContainerSandbox;
}
