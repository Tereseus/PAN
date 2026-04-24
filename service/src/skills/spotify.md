---
name: Spotify
triggers: [play {song} by {artist}, play {song} on spotify, listen to {song} by {artist}, listen to {song}, put on {song}, spotify {song}, play some {genre} music, play music, put on some music, spotify]
requires: [browser]
---
# Spotify Playback

When the user wants to play music on Spotify:

1. Use browser action "navigate" to go to https://open.spotify.com
2. If a specific song/artist was requested, search for it:
   - Navigate to: `https://open.spotify.com/search/{{song}}{{artist}}`
   - Use browser action "click_element" to click the top result's play button
3. If only a genre was requested, search: `https://open.spotify.com/search/{{genre}}`
4. Confirm to the user what's playing

If Spotify asks to log in, tell the user they need to log in first.

Respond with intent "browser" and the appropriate browser actions. Example:
```json
{"intent": "browser", "action": "navigate", "url": "https://open.spotify.com/search/bohemian rhapsody queen", "response": "Searching for Bohemian Rhapsody by Queen on Spotify."}
```
