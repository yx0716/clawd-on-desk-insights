# State Mapping

[Back to README](../README.md)

Events from all agents (Claude Code hooks, Codex JSONL, Copilot hooks) map to the same animation states:

| Agent Event | State | Animation | Clawd | Calico |
|---|---|---|---|---|
| Idle (no activity) | idle | Eye-tracking follow | <img src="../assets/gif/clawd-idle.gif" width="160"> | <img src="../assets/gif/calico-idle.gif" width="130"> |
| Idle (random) | idle | Reading / patrol | <img src="../assets/gif/clawd-idle-reading.gif" width="160"> | |
| UserPromptSubmit | thinking | Thought bubble | <img src="../assets/gif/clawd-thinking.gif" width="160"> | <img src="../assets/gif/calico-thinking.gif" width="130"> |
| PreToolUse / PostToolUse | working (typing) | Typing | <img src="../assets/gif/clawd-typing.gif" width="160"> | <img src="../assets/gif/calico-typing.gif" width="130"> |
| PreToolUse (3+ sessions) | working (building) | Building | <img src="../assets/gif/clawd-building.gif" width="160"> | <img src="../assets/gif/calico-building.gif" width="130"> |
| SubagentStart (1) | juggling | Juggling | <img src="../assets/gif/clawd-juggling.gif" width="160"> | <img src="../assets/gif/calico-juggling.gif" width="130"> |
| SubagentStart (2+) | conducting | Conducting | <img src="../assets/gif/clawd-conducting.gif" width="160"> | <img src="../assets/gif/calico-conducting.gif" width="130"> |
| PostToolUseFailure | error | Error | <img src="../assets/gif/clawd-error.gif" width="160"> | <img src="../assets/gif/calico-error.gif" width="130"> |
| Stop / PostCompact | attention | Happy | <img src="../assets/gif/clawd-happy.gif" width="160"> | <img src="../assets/gif/calico-happy.gif" width="130"> |
| PermissionRequest | notification | Alert | <img src="../assets/gif/clawd-notification.gif" width="160"> | <img src="../assets/gif/calico-notification.gif" width="130"> |
| PreCompact | sweeping | Sweeping | <img src="../assets/gif/clawd-sweeping.gif" width="160"> | <img src="../assets/gif/calico-sweeping.gif" width="130"> |
| WorktreeCreate | carrying | Carrying | <img src="../assets/gif/clawd-carrying.gif" width="160"> | <img src="../assets/gif/calico-carrying.gif" width="130"> |
| 60s no events | sleeping | Sleep | <img src="../assets/gif/clawd-sleeping.gif" width="160"> | <img src="../assets/gif/calico-sleeping.gif" width="130"> |

## Mini Mode

Drag to the right screen edge (or right-click → "Mini Mode") to enter mini mode — half-body visible at screen edge, peeking out on hover.

| Trigger | Mini Reaction | Clawd | Calico |
|---|---|---|---|
| Default | Breathing + blinking + eye tracking | <img src="../assets/gif/clawd-mini-idle.gif" width="100"> | <img src="../assets/gif/calico-mini-idle.gif" width="80"> |
| Hover | Peek out + wave | <img src="../assets/gif/clawd-mini-peek.gif" width="100"> | <img src="../assets/gif/calico-mini-peek.gif" width="80"> |
| Notification | Alert pop | <img src="../assets/gif/clawd-mini-alert.gif" width="100"> | <img src="../assets/gif/calico-mini-alert.gif" width="80"> |
| Task complete | Happy celebration | <img src="../assets/gif/clawd-mini-happy.gif" width="100"> | <img src="../assets/gif/calico-mini-happy.gif" width="80"> |

## Click Reactions

Easter eggs — try double-clicking, rapid 4-clicks, or poking Clawd repeatedly to discover hidden reactions.
