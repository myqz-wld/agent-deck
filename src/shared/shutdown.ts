export const APP_SHUTDOWN_ERROR_CODE = 'AGENT_DECK_APP_SHUTTING_DOWN' as const;
export const APP_SHUTDOWN_ERROR_MESSAGE = `[${APP_SHUTDOWN_ERROR_CODE}]`;

export class AppShutdownError extends Error {
  readonly code = APP_SHUTDOWN_ERROR_CODE;

  constructor() {
    super(APP_SHUTDOWN_ERROR_MESSAGE);
    this.name = 'AppShutdownError';
  }
}

const SERIALIZED_APP_SHUTDOWN_ERROR =
  `AppShutdownError: ${APP_SHUTDOWN_ERROR_MESSAGE}`;

export function isAppShutdownError(value: unknown): value is AppShutdownError {
  if (!(value instanceof Error)) return false;
  const message = value.message;
  return (
    value instanceof AppShutdownError ||
    message === APP_SHUTDOWN_ERROR_MESSAGE ||
    message === SERIALIZED_APP_SHUTDOWN_ERROR ||
    (
      message.startsWith('Error invoking remote method ') &&
      message.endsWith(`: ${SERIALIZED_APP_SHUTDOWN_ERROR}`)
    )
  );
}
