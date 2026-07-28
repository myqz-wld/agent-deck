import { app } from 'electron';
import log, { type LogLevel } from './logger';
import {
  createProcessStartupRecord,
  getProcessRunId,
  loadBuildIdentity,
} from './run-context';

const logger = log.scope('process-startup');
let processStartupRecordEmitted = false;

export function emitProcessStartupRecord(input: {
  schemaUserVersion: number | null;
  configuredFileLogLevel: LogLevel;
}): boolean {
  if (processStartupRecordEmitted) return false;
  processStartupRecordEmitted = true;
  let appVersion = 'unknown';
  let appPath = '';
  try {
    appVersion = app.getVersion();
  } catch {
    // The startup record remains truthful and compact if Electron metadata is unavailable.
  }
  try {
    appPath = app.getAppPath();
  } catch {
    // loadBuildIdentity maps an unavailable path to the compact "unreadable" status.
  }
  const isPackaged = app.isPackaged === true;
  const build = loadBuildIdentity({
    isPackaged,
    appPath,
    resourcesPath: process.resourcesPath ?? '',
  });
  logger.info(
    '[startup]',
    createProcessStartupRecord({
      runId: getProcessRunId(),
      pid: process.pid,
      appVersion,
      build,
      isPackaged,
      platform: process.platform,
      arch: process.arch,
      schemaUserVersion: input.schemaUserVersion,
      configuredFileLogLevel: input.configuredFileLogLevel,
    }),
  );
  return true;
}
