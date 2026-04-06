# Prism Claude Sync Extension

Manual Chrome extension for syncing selected `claude.ai` conversations into Prism Library.

## Install

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder: `extensions/claude-sync`

## Use

1. Start Prism locally so the API is available at `http://localhost:3001`
2. Open `https://claude.ai`
3. Click the floating `Sync Claude to Prism` button
4. If auto-detect cannot find your Claude organization ID, paste it once in the modal
5. Refresh the conversation list
6. Select one or more conversations
7. Click `Sync Selected`

## Notes

- This is an experimental local sync flow.
- It relies on your active `claude.ai` web session and internal Claude web APIs.
- It does not store Claude auth tokens in Prism.
- Claude bulk delete is supported in the extension when the current org/session permits the delete endpoint.
