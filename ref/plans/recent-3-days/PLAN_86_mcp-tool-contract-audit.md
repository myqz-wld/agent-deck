---
plan_id: 86
completed_at: 2026-10-13
status: completed
---

# MCP tool contract audit

## Goal

Inspect unrelated-session discovery, enumerate all Agent Deck MCP tools, and provide evidence-backed adjustment options.

## Context and constraints

Baseline: cfa43ce9dd64450859f48346d9ff069b2a3006b3. Inspection covered 20 live Local tools and up to 39 Core registrations. Preserve production source, prompt assets, installed applications, credentials, live sessions, and Git index. Use synthetic fixtures for behavioral probes. The user requested inspection and alternatives; no implementation policy was selected.

## Completed task breakdown

1. Compared Local live descriptions with registrations, schemas, guards, and handlers.
2. Inspected Server Core equivalents, optional Feishu tools, and the legacy Browser bridge.
3. Verified three functional defects and separated them from product-policy questions and wording drift.
4. Ran 24 targeted test files (343 passing tests) and isolated probes without exercising real session mutations.
5. Archived the complete matrix, findings, and three adjustment options in `ref/reviews/recent-3-days/REVIEW_321_mcp-discovery-and-tool-contracts.md`.

## Validation

The SQLite binding checksum was unchanged. The review-expiry helper was attempted but exited 1; no earlier review was used as an exemption. Record numbering and all date buckets were checked; existing records required no moves.

## Final status and next action

Audit complete. Implementation remains outside this completed audit. Recommended design: discover open work metadata within the owner/host or Core Workspace by default, retain relationship filters and bounded history access, and define separate destructive target authority. The concrete behavior and repair evidence are in REVIEW_321.
