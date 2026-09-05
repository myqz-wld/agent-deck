const ts = require('typescript');
const path = require('node:path');
const scoped = /^(src\/(renderer\/|main\/browser-use\/|preload\/api\/browser\.ts$|main\/ipc\/browser\.ts$|main\/index\/(bootstrap-infra\.ts|bootstrap-wiring\.ts|__tests__\/(checkpoint-bootstrap-entry|bootstrap-wiring-observability)\.test\.ts)$|main\/event-bus\.ts$|shared\/(browser-view|ipc-channels)\.ts$))/;
let failed = false;
for (const configName of ['tsconfig.node.json', 'tsconfig.web.json']) {
  const config = ts.readConfigFile(configName, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, composite: false, incremental: false });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file && scoped.test(path.relative(process.cwd(), d.file.fileName)));
  console.log(`${configName}: ${diagnostics.length} desktop-scope diagnostics`);
  for (const diagnostic of diagnostics) {
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    console.log(`${path.relative(process.cwd(), diagnostic.file.fileName)}:${pos.line + 1}:${pos.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }
  failed ||= diagnostics.length > 0;
}
process.exitCode = failed ? 1 : 0;
