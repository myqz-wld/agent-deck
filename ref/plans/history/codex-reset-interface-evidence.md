# Provider quota-reset interface verification

Checked: 2026-09-29. Scope: read-only checks and static protocol inspection.
No reset-consumption request was sent. No raw authentication or account response
was saved. Only selected non-identifying fields were emitted by the probes.

## Codex: confirmed shared usage summary

Local dependency: `@openai/codex` 0.159.2.

The CLI's `app-server generate-ts --experimental` output confirms:

```ts
// account/rateLimits/read
type Params = { excludeResetCreditDetails?: boolean };
type ResetSummary = { availableCount: bigint; credits: ResetCredit[] | null };
type Response = { rateLimitResetCredits: ResetSummary | null };
```

`excludeResetCreditDetails: true` skips a separate detail lookup while retaining
the count from the usage response. The default detailed read is unnecessary for
displaying counts or consuming the next available credit.

Live evidence:

- A GET to `/backend-api/wham/usage` returned HTTP 200. Its
  `rate_limit_reset_credits` object included `available_count` and
  `applicable_available_count`. No identities or token values were retained.
- An isolated CLI app-server process was initialized and sent only
  `account/rateLimits/read` with `{ excludeResetCreditDetails: true }`.
  It returned a positive `rateLimitResetCredits.availableCount`,
  `rateLimitResetCredits.credits: null`, and the normal usage window.
- The probe closed its own stdin and exited normally. Existing runtime
  processes were not stopped or restarted.

Consume contract (statically verified; not invoked):

```ts
// account/rateLimitResetCredit/consume
type Params = { idempotencyKey: string; creditId?: string | null };
type Outcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
```

`creditId` may be omitted to let the service choose an available credit. Use one
UUID per logical attempt and retain it when retrying that same attempt. Treat
`alreadyRedeemed` as an idempotent success. Refresh usage after `reset` or
`alreadyRedeemed`; do not infer which windows reset from the consume response.
Handle `nothingToReset` and `noCredit` separately from transport failures.

Reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt).

## Grok: billing read verified; reset support unconfirmed

Local dependency: `@xai-official/grok` 1.0.44.

The existing billing GET ending in `/billing?format=credits` returned HTTP 200.
Its `config` object contained `currentPeriod`, `onDemandCap`, `onDemandUsed`,
`isUnifiedBillingUser`, `prepaidBalance`, `topUpMethod`, `billingPeriodStart`, and
`billingPeriodEnd`. No reset-count or reset-redemption field was present in the
response. Static inspection of the bundled native CLI found the billing path
but did not establish a consumable-reset API. This does not prove that no Grok
service or account promotion offers resets; it establishes that the current
integration has no verified query/use contract.

## Claude: SDK usage contract checked; reset support unconfirmed

The installed Claude Agent SDK's `SDKControlGetUsageResponse` includes usage
windows, scheduled reset timestamps, model windows, and extra usage. It has no
consumable reset-count field or consume operation in this usage contract. No
Claude account mutation or credential refresh was performed.

## Implementation consequence

Start with Codex. Pass `excludeResetCreditDetails: true` in background usage reads,
preserve the returned summary in shared/remote contracts, distinguish unknown
from zero, and expose the use action only for a known positive count. Open a
confirmation dialog before consumption. A separate count query button is not
needed on the verified Codex path. Keep Claude/Grok reset controls hidden until
their capabilities are verified.
