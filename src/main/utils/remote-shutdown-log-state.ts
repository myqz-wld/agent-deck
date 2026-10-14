// A leaf module avoids importing the Remote service graph into the logging bootstrap.
let stopping = false;

export function setRemoteShutdownLogState(value: boolean): void {
  stopping = value;
}

export function isRemoteShutdownForLogging(): boolean {
  return stopping;
}
