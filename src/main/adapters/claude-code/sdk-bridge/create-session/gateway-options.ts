import { sessionRepo } from '@main/store/session-repo';

import { resolveClaudeGatewayProfile } from '../../gateway-profiles';
import type { CreateSessionOpts } from './_deps';

export function withResolvedClaudeGateway(opts: CreateSessionOpts): CreateSessionOpts {
  const persistedProvider = opts.resume
    ? sessionRepo.get(opts.resume)?.runtimeProvider
    : null;
  const profile = resolveClaudeGatewayProfile(
    opts.provider ?? persistedProvider ?? undefined,
  );
  if (!profile) return opts;

  return {
    ...opts,
    provider: profile.id,
    settingsPath: profile.settingsPath,
    profileDefaultModel: profile.defaultModel,
    providerModelAliases: profile.modelAliases,
  };
}
