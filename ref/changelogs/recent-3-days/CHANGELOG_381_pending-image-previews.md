---
changelog_id: 381
changed_at: 2026-07-22
---

# CHANGELOG_381_pending-image-previews: Preview unsent composer images

## Summary

Pending image attachments are now visible with metadata in the expanded session composer, and
unsent image thumbnails can be opened in a full-size preview before sending.

## Changes

### Pending attachment presentation

- Added a shared pending-image attachment list for the main session composer and new-session
  dialog. Compact thumbnails remain removable and are now explicit preview buttons.
- Added a detailed attachment panel to the expanded session composer with each image's filename,
  effective payload size, MIME type, and automatic-compression status.
- Kept full base64 payloads out of React state. The preview resolves only the clicked attachment's
  in-memory send payload while it is open, so the enlarged image matches what will be sent.

### Image preview behavior

- Reused the existing image lightbox frame for in-memory data URLs as well as persisted uploaded
  image paths.
- Raised the lightbox above the expanded composer and intercept Escape during capture, so Escape
  closes only the image preview first and leaves the expanded draft open.
- Focused the lightbox close button while open, trapped Tab inside the preview, and restored the
  prior thumbnail focus when the preview closes.
- Added focused component coverage for compact preview, detailed expanded metadata, removal, and
  the nested Escape lifecycle.

## Validation

- `pnpm typecheck` passed.
- Focused Vitest coverage passed 4 files and 17 tests, including the existing composer and
  new-session dialog suites.
- `pnpm test` passed 327 files and 2,933 tests; one opt-in credentialed live smoke remained
  skipped.
- `pnpm build` passed.

## Do Not Split Protection

None. The new shared attachment list and lightbox frame stay below 500 lines; the pre-existing
over-500-line image-ingestion hook was deliberately left untouched.
