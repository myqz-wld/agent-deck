const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const ts = require(path.resolve('node_modules/typescript'));
const changed = [...new Set([
  ...execFileSync('git', ['diff', '--name-only', '--', 'src/main/adapters'], {encoding:'utf8'}).trim().split('\n'),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src/main/adapters'], {encoding:'utf8'}).trim().split('\n'),
])].filter(p => p.endsWith('.ts')).map(p => path.resolve(p));
const config = ts.readConfigFile('tsconfig.node.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const options = {...parsed.options, noEmit:true, composite:false, incremental:false};
if (process.argv.includes('--organize')) {
  const host = {
    getScriptFileNames: () => changed,
    getScriptVersion: () => '1',
    getScriptSnapshot: file => { const s = ts.sys.readFile(file); return s === undefined ? undefined : ts.ScriptSnapshot.fromString(s); },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => options,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
  };
  const service = ts.createLanguageService(host);
  for (const file of changed.filter(p => /(?:fixture|\.test)\.ts$/.test(p))) {
    const edits = service.organizeImports({type:'file', fileName:file}, {}, {});
    for (const edit of edits) {
      if (edit.fileName !== file) throw new Error('unexpected cross-file edit');
      let source = fs.readFileSync(file, 'utf8');
      for (const e of [...edit.textChanges].sort((a,b) => b.span.start-a.span.start)) {
        source = source.slice(0,e.span.start) + e.newText + source.slice(e.span.start+e.span.length);
      }
      fs.writeFileSync(file,source);
    }
  }
  service.dispose();
}
const program = ts.createProgram(changed, options);
const errors = changed.flatMap(file => {
  const source = program.getSourceFile(file);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
});
const formatHost = {getCanonicalFileName:p=>path.relative(process.cwd(),p),getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'};
process.stdout.write(ts.formatDiagnostics(errors,formatHost));
console.log(`Checked ${changed.length} adapter files: ${errors.length} diagnostics.`);
process.exitCode = errors.length ? 1 : 0;
