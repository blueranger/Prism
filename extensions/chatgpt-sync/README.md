# Prism ChatGPT Sync Extension

Manual Chrome extension for syncing selected ChatGPT personal conversations into Prism Library.

## Install

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder: `extensions/chatgpt-sync`

## Use

1. Start Prism locally so the API is available at `http://localhost:3001`
2. Open `https://chatgpt.com`
3. Click the floating `Sync to Prism` button
4. Refresh the conversation list
5. Select one or more conversations
6. Optionally choose a Prism project
7. Click `Sync Selected`

## Notes

- This is an experimental local sync flow.
- It relies on ChatGPT's web session and internal web APIs.
- It does not store ChatGPT tokens in Prism.
