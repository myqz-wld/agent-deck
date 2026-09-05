const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = process.cwd();
const out = '.ref/reviews/2026-09-04-project-scan';
fs.mkdirSync(out, { recursive: true });
const tracked = cp.execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const all = tracked.filter(p => p.startsWith('src/') && /\.[cm]?[jt]sx?$/.test(p));
const production = all.filter(p => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p) && !p.includes('/__tests__/') && !p.endsWith('.d.ts'));
const allSet = new Set(all);
const aliases = Object.fromEntries(['clients','composition','contracts','core','gateways','hosts','main','preload','protocol','renderer','shared'].map(n=>['@'+n+'/*',['src/'+n+'/*']]));
const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: root, paths: aliases, allowJs: true, jsx: ts.JsxEmit.ReactJSX };
const cache = ts.createModuleResolutionCache(root, p=>p, options);
const graph = new Map();
const unresolved = [];
const computed = [];
const edges = [];
for (const file of all) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const targets = new Set();
  function add(raw, node, kind) {
    const spec = raw.split('?')[0];
    if (!spec.startsWith('.') && !Object.keys(aliases).some(a=>spec.startsWith(a.slice(0,-1)))) return;
    const resolved = ts.resolveModuleName(spec, path.resolve(file), options, ts.sys, cache).resolvedModule;
    const target = resolved ? path.relative(root,resolved.resolvedFileName) : null;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if(target && allSet.has(target)){targets.add(target);edges.push({file,line,target,kind});}
    else if(!/\.(css|scss|svg|png|jpg|gif|html|json)$/.test(spec)) unresolved.push({file,line,spec});
  }
  function visit(node) {
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text,node,'module');
    if(ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) add(node.moduleReference.expression.text,node,'require');
    if(ts.isCallExpression(node) && (node.expression.kind===ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression)&&node.expression.text==='require'))){
      const arg=node.arguments[0];
      if(arg && ts.isStringLiteralLike(arg)) add(arg.text,node,'dynamic');
      else computed.push({file,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,expression:node.getText(source).slice(0,160)});
    }
    ts.forEachChild(node,visit);
  }
  visit(source); graph.set(file,targets);
}
const headless = [...fs.readFileSync('scripts/build-linux-headless.mjs','utf8').matchAll(/['"](src\/hosts\/[^'"\n]+\.ts)['"]/g)].map(m=>m[1]);
const roots = [...new Set(['src/main/index.ts','src/preload/index.ts','src/renderer/main.tsx',...headless])];
function closure(starts) {const seen=new Set(); const stack=[...starts]; while(stack.length){const file=stack.pop();if(seen.has(file))continue;seen.add(file);for(const target of graph.get(file)||[])stack.push(target);}return seen;}
const reachable = closure(roots);
const testReachable = closure(all.filter(p=>/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)));
const orphans = production.filter(p=>!reachable.has(p)).map(file=>({file,testReachable:testReachable.has(file)}));
const result = {method:'Static and literal dynamic imports/exports, including type imports and nodeWorker query imports. Computed dynamic imports and runtime registration need separate inspection. Reachability does not prove symbol use.', roots, allModules:all.length, productionModules:production.length, reachableProduction:production.filter(p=>reachable.has(p)).length, orphans, unresolvedProduction:unresolved.filter(r=>production.includes(r.file)), computedProduction:computed.filter(r=>production.includes(r.file))};
fs.writeFileSync(out+'/entry-graph.json',JSON.stringify(result,null,2)+'\n');
fs.writeFileSync(out+'/entry-edges.json',JSON.stringify(edges,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
