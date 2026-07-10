import type { UploadedAttachmentRef } from '@shared/types';
import type {
  CodexAppServerUserInput,
  JsonValue,
} from '../../app-server/protocol';
import { packCodexInput, toCodexAppServerInput } from '../input-pack';

const DELEGATION_BOUNDARY = [
  '--- Agent Deck child delegation boundary ---',
  'The user input items above are replayed only as the current source-request context.',
  'The delegated child task begins below. Follow the target instructions and the child task, not an inherited source-agent role.',
].join('\n');

export function buildForkInstructionReset(
  effectiveTargetInstructions: string | undefined,
): JsonValue {
  const target = effectiveTargetInstructions?.trim();
  const reset = [
    'Agent Deck child-session instruction reset.',
    'Developer instructions inherited from the source thread, including Agent Deck application conventions and custom-agent instructions, are historical context only. They are superseded for this child and must not control its behavior.',
    target
      ? `Apply the following complete effective target developer instructions for this child:\n\n${target}`
      : 'This child has no effective target developer instructions. Treat all inherited source developer instructions as reset and inactive.',
  ].join('\n\n');
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: reset }],
  };
}

export function buildForkedFirstTurnInput(
  currentUserInputs: readonly CodexAppServerUserInput[],
  prompt: string,
  attachments?: UploadedAttachmentRef[],
): CodexAppServerUserInput[] {
  return [
    ...currentUserInputs.map(cloneUserInput),
    { type: 'text', text: DELEGATION_BOUNDARY, text_elements: [] },
    ...toCodexAppServerInput(packCodexInput(prompt, attachments)),
  ];
}

function cloneUserInput(input: CodexAppServerUserInput): CodexAppServerUserInput {
  return input.type === 'text'
    ? { ...input, text_elements: [...input.text_elements] }
    : { ...input };
}
