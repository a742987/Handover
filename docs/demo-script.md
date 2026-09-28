# 45-second demo script

The demo video is recorded against a **real run** of the tool, not a mock-up. This document is the script and the honesty rules for whoever records it.

## Script

| Time | On screen | Voice-over / caption |
|---|---|---|
| 0–5 s | One-line handover scenario (chat message or ticket): "You're taking over this project next week. What should you ask first?" | "Next week I take over this project. What should I ask first?" |
| 5–12 s | A real terminal: the actual `handover gen` command running, collection progress visible | "Handover reads the Git history and PR discussions." |
| 12–23 s | The book's **action summary**: one concrete "confirm before the handover" item with its evidence refs | "Maintenance on this module is concentrated in one person — the handover plan needs confirming." |
| 23–33 s | Clicking an evidence ref through to the original PR/commit; the actual discussion | "And here is why that odd design from years ago still exists." |
| 33–42 s | Chapter 6: the departing engineer's **captured** first-person answer | "What the history can't show, the departing engineer confirms in person." |
| 42–45 s | The sample report page and the repo URL | "Read the full sample. Try it on your own project." |

## Recording rules

- **Real results only.** The terminal shows a real run; the report is a real render. The [committed sample](../examples/sample-report/handover-book-dana-dev.md) is a labelled synthetic scenario and may be used as the subject — say so on screen if it is.
- **Time is time.** Video length is not generation time. If the capture step is sped up or cut, label it on screen ("collection edited; full run took X s in this repo"). Never simulate progress bars.
- **Runtime conditions stated.** The video description (or an end card) records the machine, repository size, flags used (`--no-llm` or provider), and the measured collection/synthesis time.
- **The links are real.** The end card links to the repository and the sample report; the sample link in the repo README points back to this script until a recorded video replaces it.
