---
changelog_id: 669
changed_at: 2026-09-30
---

# Readable Markdown in ordinary Feishu replies

## Summary

Formatted assistant replies use an untitled Feishu rich-text post instead of displaying raw
Markdown. Simple conversation remains plain text without a source label. Work and approval
cards keep their existing presentation and actions.

## Changes

- Select native post with one md node for formatted content, including lists, tables, task lists,
  emphasis and code. Preserve the original text for ordinary short chat.
- Parse links without changing inline or fenced code. Local paths become copyable text with
  spaces, parentheses and code-span delimiters preserved. Encoded controls remain encoded.
- Render model-produced raw HTML, mention tags and images as text. Keep ordinary web links;
  do not upload images or convert content into provider mentions.
- Preserve destination/source checks, message UUIDs and unknown-outcome behavior. A failed or
  ambiguous rich-text send does not trigger a second plaintext send. Enforce the encoded post
  size bound before the API call.
- Promote the existing mdast-util-from-markdown dependency from development to runtime scope,
  retaining its range and resolved version 2.0.3.

## Validation

Renderer and official SDK transport regressions cover content selection, local links, literal
code, entity handling, source/UUID preservation, payload limits and uncertain delivery. Full
integrated validation and managed activation are recorded in
[REVIEW_310](../../reviews/recent-week/REVIEW_310_feishu-markdown-replies.md).

Managed activation passed in [PLAN_79](../../plans/recent-week/PLAN_79_feishu-markdown-activation.md);
the owner confirmed normal display of the real formatting sample.

The [official Feishu message structure](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)
defines the title-less post and CommonMark/GFM md node used here. No model, prompt, runtime-control,
pairing, schema or permission change is needed.

## Do Not Split Protection

None. Changed source files remain below 500 lines. No Desktop or Worker replacement is required.
