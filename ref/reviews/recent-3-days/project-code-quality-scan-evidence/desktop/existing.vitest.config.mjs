import config from './vitest.config.mjs';
export default { ...config, test: { ...config.test, environment:'node', include:[
'src/renderer/components/SessionDetail/__tests__/use-file-changes.test.tsx',
'src/renderer/remote-host/use-remote-host-snapshot.test.tsx',
'src/main/browser-use/browser-presentation-controller.test.ts',
'src/hosts/electron/registry-lifecycle-races.test.ts',
] } };
