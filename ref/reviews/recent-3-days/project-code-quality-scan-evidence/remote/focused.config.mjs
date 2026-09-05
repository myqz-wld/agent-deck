import config from './scan.config.mjs';
export default {
  ...config,
  test: {
    ...config.test,
    include: [
      'src/gateways/feishu/mapper-transport.test.ts',
      'src/gateways/feishu/sdk.test.ts',
      'src/gateways/im/audit-stream-generation.test.ts',
      'src/hosts/local-worker/frame-bridge.test.ts',
      'src/hosts/provider-session/multiplex.test.ts',
      'src/protocol/bridge-admission.test.ts',
    ],
  },
};
