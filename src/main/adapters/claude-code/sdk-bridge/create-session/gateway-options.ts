import { sessionRepo } from '@main/store/session-repo';

import { resolveClaudeGatewayProfile } from '../../gateway-profiles';
import type { CreateSessionOpts } from './_deps';

export function withResolvedClaudeGateway(opts: CreateSessionOpts): CreateSessionOpts {
  const persistedGateway = opts.resume
    ? sessionRepo.get(opts.resume)?.runtimeProvider
    : null;
  const profile = resolveClaudeGatewayProfile(
    opts.gateway ?? persistedGateway ?? undefined,
  );
  if (!profile) return opts;

  return {
    ...opts,
    gateway: profile.id,
    settingsPath: profile.settingsPath,
    profileDefaultModel: profile.defaultModel,
    gatewayModelAliases: profile.modelAliases,
  };
}
