---
name: YouTube
triggers: [youtube, play video, watch video, play on youtube, youtube video]
requires: [browser]
---
# YouTube Playback

When the user wants to watch or play something on YouTube:

1. Use browser action "navigate" to: https://www.youtube.com/results?search_query={query}
   Replace {query} with the URL-encoded search term.
2. After navigation, use browser action "click_element" to click the first video result
3. Confirm to the user what's playing

For music requests that mention YouTube specifically, search YouTube instead of Spotify.

Respond with intent "browser" and the appropriate browser actions. Example:
```json
{"intent": "browser", "action": "navigate", "url": "https://www.youtube.com/results?search_query=lofi+hip+hop", "response": "Searching YouTube for lofi hip hop."}
```
