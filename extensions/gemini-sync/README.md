# Prism Gemini Sync Extension

Manual Chrome extension for syncing selected `gemini.google.com` conversations into Prism Library.

## Install

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder: `extensions/gemini-sync`

## Use

1. Start Prism locally so the API is available at `http://localhost:3001`
2. Open `https://gemini.google.com`
3. Click the floating `Sync Gemini to Prism` button
4. Refresh the conversation list
5. Select one or more conversations
6. Optionally capture more sidebar history entries
7. Click `Sync Selected`

## Notes

- This is an experimental local sync flow.
- It relies on your active Gemini web session and visible conversation history in the Gemini UI.
- Conversation content is scraped from the current page or hidden same-origin Gemini pages, not from a stable public Gemini API.
- It does not store Google auth tokens in Prism.
