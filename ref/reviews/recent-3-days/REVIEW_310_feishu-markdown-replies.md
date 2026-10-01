---
review_id: 310
reviewed_at: 2026-09-30
baseline_commit: 498a805aa7d342acb89dbed8e4acebf94e5443ef
expired: false
---

# Feishu ordinary-reply formatting

## Scope and findings

The owner reported raw Markdown in ordinary assistant replies. The transport always selected
text for replies without cards, although Feishu supports untitled rich-text posts with a native
md node. Fix presentation at the provider boundary; keep prompts and source ownership unchanged.

```review-scope
src/gateways/feishu/message-renderer.ts
src/gateways/feishu/message-renderer.test.ts
src/gateways/feishu/message-transport.test.ts
src/gateways/feishu/transport.ts
src/gateways/feishu/types.ts
src/gateways/feishu/sdk.ts
src/gateways/feishu/card-renderer.ts
src/gateways/im/text-policy.ts
package.json
pnpm-lock.yaml
```

One MEDIUM presentation issue is repaired. The new renderer selects text or post, normalizes
non-web links using parsed node offsets, and leaves code literals intact. Local paths remain
readable; encoded control data cannot be reintroduced by decoding. Raw HTML/mention/image nodes
remain visible text instead of active provider entities. No change to native approval cards.

## Validation and evidence

Source inspection includes the official SDK create/reply payloads, callback-card route, event
source binding, provider UUID generation and delivery error handling. Tests assert no plaintext
retry after an unknown rich-text outcome and no API request for oversized encoded content.
The existing parser is promoted to runtime scope without a version change or shared dependency
installation. Review-expiry analysis was run; this is a bounded local review, not an independent
agent review or a waiver for unrelated expired coverage.

The final integrated run passes 6,968 tests with six existing skips, including 53 focused renderer,
transport, mapper and SDK tests. It includes the encoded-control regression and main's separately
committed Pending-question work. Type/architecture, reproducible headless build, both native
builds, headless and deployment checks pass. The Electron SQLite binding remains unchanged.

Actual artifact audit inspected 23 headless files and both native archives, each containing 26
regular members and the exact built Feishu bundle. Descriptor hashes match; no personal paths,
private-key payloads or unsafe archive paths were found. Native release entrypoints explicitly
limit packaged inputs. The arm64 artifact is
`2ec4ababd559203f42611e0b4e8d540ea7ecc1d8caaca517cac72cddc84b8f0e`.

## Residual risk and activation

Actual Feishu client rendering still needs an owner-visible sample after managed activation.
The official content contract supports the chosen post format; automated tests verify the sent
payload and delivery boundaries. Desktop and Worker require no replacement. Ordinary chat has
no title, source label or card wrapper, while work and approval cards are unchanged.

The older no-reply incident remains deferred by the owner. No new request or approval is created
for the optional old-card visual check. All changed source files remain below 500 lines.

Related change: [CHANGELOG_669](../../changelogs/recent-3-days/CHANGELOG_669_feishu-markdown-replies.md).
