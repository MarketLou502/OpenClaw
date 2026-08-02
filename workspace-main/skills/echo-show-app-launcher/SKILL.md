---
name: echo-show-app-launcher
description: Launch an allowlisted app (currently Spotify) on the kitchen Echo Show over ADB — for requests like "open Spotify on the Echo" or "switch the Echo to Spotify".
---

# Echo Show app launcher

For requests such as "open Spotify on the Echo," "open Spotify, Echo," or
"switch the Echo to Spotify," run the allowlisted deterministic workflow:

```bash
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/echo-app-workflow.js open --app spotify
```

Use its `reply` as the factual core of the response. This works identically
from native iMessage, Home Assistant Voice PE, or the Control UI because all
three route to Main. Never substitute raw `adb shell` commands based on user
text; add future apps to `config/echo-apps.json` only after verifying their
package on the Echo. Wireless debugging must remain enabled on the Echo.
