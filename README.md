# Auto-Prompt: Go grab a coffee

Let the AI Always Work, Then Check: Seamless Task Queuing for Busy Minds.

## Why this exists
Sometimes you have multiple, repetitive tasks for ChatGPT, Gemini, Grok, or Claude—like asking them to draft variations, generate batches of images, or produce several code snippets. Manually pasting a prompt, waiting, then pasting the next is slow and distracting. This extension lets you queue all prompts, hit Start, and get back to work while it runs for you. 

## What it does
Auto-Prompt automates sending a sequence of prompts to AI chat sites (ChatGPT, Gemini, Grok, Claude). Paste your list, click Start, and it will:
- Send the first prompt
- Wait until the AI finishes
- Send the next prompt
- Repeat until done

You can leave the page or close the popup. The background worker keeps running. 


If you have more ideas to improve efficiency with these AI products, open an issue or ping me—happy to iterate.




## Supported sites
- ChatGPT: `chat.openai.com`, `chatgpt.com`
- Google Gemini: `gemini.google.com`
- Grok: `grok.x.ai`
- Claude: `claude.ai`

## Install (Load unpacked)
1. Clone this repo
2. Open Chrome → `chrome://extensions`
3. Enable Developer mode
4. Click Load unpacked → select the repo folder

## Files
- `manifest.json`: MV3 config (permissions, background, popup)
- `background.js`: Orchestrates prompts, persists settings/history, sends notifications
- `content.js`: Injected into pages; fills inputs, clicks send, waits for completion
- `popup.html` + `popup.js`: UI for prompts, settings, history, theme; progress bar

## Usage
1. Open one of the supported sites and log in
2. Click the extension icon to open the popup
3. Paste prompts (one per line)
4. Optionally set:
   - Max wait (seconds)
   - Stable (seconds)
   - Poll interval (seconds)
   - System prompt and whether to prepend it to each prompt
   - Theme (Dark/Light)
5. Click Start Automation
6. Watch progress and status; a notification appears when done

## Parallel fan-out mode (one tab per prompt)
Use this mode when you want to launch multiple prompts concurrently.

### Setup
1. Open a supported site in the active tab.
2. In extension options, enable **Parallel: open one tab per prompt (max 10)**.
3. Optional: put `(new tab)` on its own line in the prompt box to split prompt sets by tab.
4. Optional: set **Custom new chat URL**.
   - If provided, all spawned tabs use this URL.
   - If empty, the extension reuses the active tab URL.
5. Start automation with up to 10 tabs.

### Expected behavior
- One inactive background tab is opened per prompt group:
  - no `(new tab)` tags: one tab per prompt
  - with `(new tab)` tags: one tab per group between tags
- Tab launches are sequential by launch-readiness (next tab starts as soon as the previous tab is loaded and accepts its first prompt).
- Tabs are launched in true fan-out mode (no waiting for earlier tab completion before launching later tabs).
- Each tab processes its own prompt group sequentially.
- Tabs remain open after completion.

### Cap and precedence
- Hard cap in v1: 10 prompts/tabs.
- If parallel mode is ON, the sequential **Send each prompt in a new chat** flow is ignored for that run.

### Pause/Resume semantics
- Pause stops only new tab launches.
- Already launched tabs continue processing.
- Resume restarts only the launch loop.

### Stop semantics
- Stop cancels pending tab launches and ends the current session state.
- Already launched tabs are not force-stopped.

## Prompt history
- Click Save current as history to store the current prompts + settings
- The list shows recent histories (deduplicated)
- Use Load to restore a specific history
- Use Delete to remove entries

## Notes and tips
- UIs of AI sites change frequently. If detection breaks, update selectors in `content.js`
- ChatGPT uses a ProseMirror editor; we insert text using editor-safe events
- Completion detection:
  - ChatGPT: send-button readiness + DOM stability + absence of stop
  - Gemini/Grok/Claude: absence of stop/spinner/typing indicators
- You can tweak default timing in the popup; seconds are converted to ms internally


## Development
- Edit files in place and reload the extension from `chrome://extensions`
- Use DevTools for background (service worker) and popup to debug

## License
MIT
