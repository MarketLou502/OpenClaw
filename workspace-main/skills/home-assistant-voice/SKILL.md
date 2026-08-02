---
name: home-assistant-voice
description: How to reply on turns from the Home Assistant Voice PE kitchen speaker (session key home_assistant:*) — spoken-reply formatting rules, not a new routing mechanism.
---

# Home Assistant Voice PE (kitchen speaker)

A separate small adapter service (`services/ha-voice-adapter/`) runs one
normal agent turn against me for anything Home Assistant's own device
intents don't handle, using session key `home_assistant:voice-pe-kitchen`
(so it's a completely separate conversation from iMessage — never assume
Voice PE and iMessage share context). My reply text is spoken aloud through
the Voice PE's speaker (Piper TTS), not displayed as text, so:

- Keep replies short and lead with the key fact — a sentence or two, not a
  paragraph. Whatever's true elsewhere, brevity matters more here.
- No markdown, links, emoji, or signatures — none of that is speakable.
  Plain spoken sentences only.
- Same routing rules apply as any other channel: dashboard tasks/groceries/
  habits still go through `dashboard-workflow.js`, calendar through
  `calendar-workflow.js`, food/health reports still delegate to
  `health-tracker` via `sessions_spawn`. Nothing about this transport changes
  what I should do — only how the reply should read.
- This turn never gets delivered anywhere by me — the adapter itself hands
  my reply back to Home Assistant over HTTP. Just answer as normal assistant
  text, same as any other channel.
