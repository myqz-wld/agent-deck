import type { SessionCloseFn, SessionRenameHookFn } from './_deps';

let sessionCloseFn: SessionCloseFn | null = null;
let sessionRenameHookFn: SessionRenameHookFn | null = null;

export function setSessionCloseFn(fn: SessionCloseFn | null): void {
  sessionCloseFn = fn;
}

export function getSessionCloseFn(): SessionCloseFn | null {
  return sessionCloseFn;
}

export function setSessionRenameHookFn(fn: SessionRenameHookFn | null): void {
  sessionRenameHookFn = fn;
}

export function getSessionRenameHookFn(): SessionRenameHookFn | null {
  return sessionRenameHookFn;
}
