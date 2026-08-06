import type { GrokCreateOpts } from '@main/adapters/types';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';

import type { GrokEnqueueOptions } from './turn-queue-types';

interface GrokInitialTurnInput {
  text: string;
  attachments: GrokCreateOpts['attachments'];
  options: GrokEnqueueOptions;
}

export function resolveGrokInitialTurn(
  options: GrokCreateOpts,
  trustedTurn?: TrustedContinuationInitialTurn,
): GrokInitialTurnInput | null {
  if (
    !trustedTurn &&
    options.prompt === undefined &&
    !options.attachments?.length
  ) return null;
  return {
    text: trustedTurn?.persistedUserText ?? options.prompt ?? '',
    attachments: options.attachments,
    options: {
      handOff: options.handOff,
      ...(trustedTurn
        ? {
            providerText: trustedTurn.providerPrompt,
            continuation: trustedTurn.metadata,
          }
        : {}),
    },
  };
}
