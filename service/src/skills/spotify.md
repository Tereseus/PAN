---
name: Spotify
triggers: [play music, spotify, play song, listen to, play some, put on some music]
requires: [browser]
---
# Spotify Playback

When the user wants to play music on Spotify:

1. Use browser action "navigate" to go to https://open.spotify.com
2. If a specific song or artist is requested, use browser action "navigate" to: https://open.spotify.com/search/{query}
3. After navigation, use browser action "click_element" to click the top result's play button
4. Confirm to the user what's playing

If Spotify asks to log in, tell the user they need to log in first.

Respond with intent "browser" and the appropriate browser actions. Example:
```json
{"intent": "browser", "action": "navigate", "url": "https://open.spotify.com/search/bohemian rhapsody", "response": "Searching for Bohemian Rhapsody on Spotify."}
```
