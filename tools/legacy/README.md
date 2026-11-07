# Legacy build inputs

This directory is archived for provenance only.  It is not read by
`tools/build_content.py` anymore.

- `build_content.py` — the old userscript-to-extension string patcher.  Its
  anchors drifted away from `src/original.user.js` and it could no longer
  rebuild the shipped content script.
- `media_summary.js` / `video_summary.js` — the old hook fragments that were
  injected by that patcher.

The maintained content script source is `src/extension.content.js`.
