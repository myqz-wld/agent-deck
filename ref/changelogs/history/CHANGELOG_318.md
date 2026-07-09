# CHANGELOG 318: Diff walkthrough routing and diff presentation guidance

## Summary

Updated the durable prompt/tool metadata that steers step-by-step diff walkthroughs.

## Changes

- Clarified the MCP `present_diff` tool description so it covers both final approval gates and per-fragment confirmation during step-by-step diff or conflict walkthroughs.
- Clarified the `instructions` argument description so walkthrough callers can scope what the user should confirm for the current fragment.
- Updated the Skill Market `diff-walkthrough` source skills and the installed Codex skill copy so requests to walk, go over, or step through a diff route to walkthrough behavior instead of one-pass/adversarial review behavior.

## Validation

- `pnpm typecheck`
- Manual frontmatter structure check for the updated `diff-walkthrough` skill files.
- Verified Claude/Codex Skill Market `diff-walkthrough` skill files and the installed Codex skill copy are aligned.
