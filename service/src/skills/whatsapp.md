---
name: WhatsApp
triggers: [whatsapp, send message, text someone, message on whatsapp, send a whatsapp]
requires: [browser]
---
# WhatsApp Web Messaging

When the user wants to send a WhatsApp message:

1. First check if WhatsApp Web is already open using browser action "list_tabs" with query "WhatsApp"
2. If not open, use browser action "navigate" to https://web.whatsapp.com
3. Once WhatsApp Web is open, use browser action "activate_tab" to switch to it
4. Use browser action "click_element" to click the search bar, then "type_text" to search for the contact name
5. Click on the contact from search results
6. Use browser action "type_text" to type the message in the message input
7. Use browser action "click_element" to click the send button (or type Enter)

If the user doesn't specify a contact, ask them who they want to message.
If the user doesn't specify a message, ask them what they want to say.

Respond with intent "browser" and chain the actions. Start by checking tabs:
```json
{"intent": "browser", "action": "list_tabs", "query": "WhatsApp", "response": "Let me check if WhatsApp is open."}
```
