# T1: Provider-Neutral MCP Definitions

## Assignment (lead-owned)

- State: complete; implemented and validated by the sequential lead.
- Classification: complex implementation task with cross-provider runtime boundaries.
- Owner: implementation lead; no delegation is authorized by this record.
- Plan: `ref/plans/recent-3-days/PLAN_95_runtime-component-injection.md`.
- Goal: constructing Agent Deck's generic MCP tool registry must not import the Anthropic SDK at runtime.
- Preserve every public name, description, input/output schema, annotation, metadata value, authentication boundary, error/result behavior, and handler dispatch.
- Keep the Claude SDK server-instance wrapper at the Claude adapter boundary. Keep Desktop HTTP and Server Core semantics aligned without merging host-specific services.

## Inputs and allowed write area

Inspect the plan and repository instructions first, then:

- `src/main/agent-deck-mcp/tools/index.ts`
- `src/main/agent-deck-mcp/tool-policy.ts`
- `src/main/agent-deck-mcp/server.ts`
- `src/main/agent-deck-mcp/tools.ts` if its re-export surface needs adjustment
- A small SDK-neutral definition module under `src/main/agent-deck-mcp/`
- Focused existing or new tests under `src/main/agent-deck-mcp/__tests__/`
- This task file's outcome section and the plan's execution state

Read-only counterparts:

- `src/hosts/server-core/mcp-server.ts` and host-specific registration modules
- `src/main/adapters/claude-code/sdk-loader.ts`
- Installed Claude SDK helper declarations and implementation

Do not edit prompt prose, tool descriptions, `resources/`, user configuration, provider packages, unrelated host handlers, or running processes in this task. If preserving a contract is impossible within this scope, report the evidence before expanding the task.

## Implementation steps

1. Capture the public registry contract using existing test fixtures and schema serialization. Do not import Electron or initialize a real provider to do so.
2. Verify Anthropic's `tool()` helper behavior relevant to the current usage, including metadata and handler wrapping.
3. Add the minimal provider-neutral tool record/helper and replace the runtime SDK dependency.
4. Change the policy filter to a structural name constraint.
5. Retain MCP SDK registration and the Claude SDK instance return type where integration requires it.
6. Add a meaningful regression that a generic registry build succeeds with the Anthropic loader unavailable and that contract output is identical.
7. Run task-focused tests and type checks appropriate to the shared boundary; leave the full suite/build to the final integration track unless failures require earlier expansion.

## Acceptance checklist

- [x] Generic tool construction contains no runtime `loadSdk()` call.
- [x] Tool names/count and policy filtering are unchanged.
- [x] Serialized input/output schemas, description strings, annotations, and metadata are unchanged.
- [x] SDK in-process and HTTP registration tests preserve handler behavior.
- [x] Host-specific Core contracts remain compatible.
- [x] No source file exceeds the repository guardrail without its required rationale.
- [x] No live provider calls, credential reads, or host process changes occurred.
- [x] Outcomes, validation, and next action are recorded below and in the main plan.

## Implementation outcome

Added `tool-definition.ts`; removed the Anthropic loader from generic construction and the SDK type from policy filtering. No tool prose or schemas changed. Baseline wire-catalog fingerprints captured with SDK 0.3.299 match all three profiles with the loader unavailable. Existing handler/in-memory MCP tests pass (112 tests across four files); Node TypeScript check passes. Next: T2.

## Lead acceptance

Accepted by the lead using independently captured pre-change wire fingerprints, existing handler regressions, and TypeScript validation. No delegated reviewer was used.
