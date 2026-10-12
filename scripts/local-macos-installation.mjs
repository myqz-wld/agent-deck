/** Apply one prepared bundle, restore paused services, and clean only owned temporary copies. */
export async function installMacApplication(paths, operations) {
  const { sourceApp, installedApp, stagingApp, previousApp, stopRunning } = paths;
  const op = operations;
  let restoreServices = async () => {};
  let movedPrevious = false;
  let installedNew = false;
  let failure;
  try {
    op.assertStopped(stagingApp);
    if (op.exists(previousApp)) throw new Error('发现尚未恢复的安装备份，已取消安装。');
    op.remove(stagingApp);
    op.prepare(sourceApp, stagingApp);
    if (stopRunning) {
      restoreServices = await op.pauseServices(installedApp);
      await op.stop(installedApp);
    }
    op.assertStopped(installedApp);
    if (op.exists(installedApp)) {
      op.move(installedApp, previousApp);
      movedPrevious = true;
    }
    op.move(stagingApp, installedApp);
    installedNew = true;
    op.validate(installedApp);
    op.assertStopped(sourceApp);
    op.remove(sourceApp);
  } catch (error) {
    failure = error;
    if (movedPrevious || installedNew) {
      try {
        if (installedNew) op.remove(installedApp);
        if (movedPrevious) op.move(previousApp, installedApp);
        movedPrevious = false;
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError],
          `${error.message} 安装备份恢复失败：${rollbackError.message}`);
      }
    }
  } finally {
    try { await restoreServices(); } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], `${failure.message} ${error.message}`)
        : error;
    }
    try {
      op.assertStopped(stagingApp);
      op.remove(stagingApp);
      if (!failure && movedPrevious) op.remove(previousApp);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], `${failure.message} ${error.message}`)
        : error;
    }
  }
  if (failure) throw failure;
}
