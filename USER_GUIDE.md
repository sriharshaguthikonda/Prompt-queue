# Auto-Prompt: User Guide & FAQ

## Table of Contents
1. [Getting Started](#getting-started)
2. [Main Features](#main-features)
3. [Settings & Options](#settings--options)
4. [Presets](#presets)
5. [History Management](#history-management)
6. [Troubleshooting](#troubleshooting)
7. [FAQ](#faq)

---

## Getting Started

### Installation
1. Clone or download the extension files
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right corner)
4. Click **Load unpacked** and select the extension folder
5. The extension icon will appear in your toolbar

### First Run
1. Click the extension icon to open the sidebar
2. Open ChatGPT, Gemini, Grok, or Claude in the active tab
3. Enter your prompts (one per line) in the text box
4. Click **Start Automation**
5. The extension will send prompts and wait for responses automatically

---

## Main Features

### 📝 Prompt Input
- **Prompts (one per line)**: Enter multiple prompts, each on a new line
- **Prompt Counter**: Shows how many prompts are loaded
- **Auto-expand**: The textarea expands when you click on it for easier editing

### 🤖 System Prompt
- **Prepend to each prompt**: Optional system prompt prepended to every prompt
- **Checkbox**: Enable/disable system prompt prepending
- **Compact by default**: Takes minimal space, expands when focused
- Example: "You are a helpful assistant. Be concise."

### ▶️ Automation Controls
- **Start Automation**: Begins processing all prompts
- **Stop**: Stops the current automation
- **Progress Bar**: Visual indicator of automation progress
- **Status Badge**: Shows current state (Idle, Running, Complete, Error)

### 📊 Real-time Feedback
- **Status Display**: Shows which prompt is being processed (e.g., "Running prompt 3 of 8...")
- **Countdown Timer**: Shows remaining stable time during automation
- **Toast Notifications**: Success/error messages appear at bottom-right

---

## Settings & Options

### Timing Options

#### Max Wait (seconds)
- **Default**: 180 seconds (3 minutes)
- **Purpose**: Maximum time to wait for a response per prompt
- **Range**: 5 - 86,400 seconds (up to 24 hours)
- **When to adjust**: Increase for complex tasks, decrease for quick responses

#### Stable (seconds)
- **Default**: 1.2 seconds
- **Purpose**: How long the page must stay unchanged to consider response complete
- **Range**: 0.2 - 60 seconds
- **When to adjust**: Increase if responses are still being generated, decrease for faster completion

#### Poll Interval (seconds)
- **Default**: 0.3 seconds
- **Purpose**: How often the extension checks for changes
- **Range**: 0.05 - 5 seconds
- **When to adjust**: Smaller = faster detection but more CPU usage

### Advanced Options

#### Enable Max Wait Timeout
- **Default**: Enabled (checked)
- **When enabled**: Automation stops after max wait seconds
- **When disabled**: Waits indefinitely for response (useful for very long-running tasks)
- **Tip**: Disable this if you're getting timeout errors on complex tasks

#### Disable Buttons During Automation
- **Default**: Enabled (checked)
- **Purpose**: Prevents accidental clicks while automation is running
- **When disabled**: Buttons remain clickable during automation
- **Tip**: Keep enabled to avoid interrupting automation

---

## Presets

Quick-set timing configurations for common scenarios:

### ⚡ Fast
- Max Wait: 60 seconds
- Stable: 0.5 seconds
- Poll: 0.2 seconds
- **Best for**: Quick Q&A, simple tasks

### ⚖️ Balanced (Default)
- Max Wait: 180 seconds
- Stable: 1.2 seconds
- Poll: 0.3 seconds
- **Best for**: General use, most tasks

### 🔍 Thorough
- Max Wait: 300 seconds
- Stable: 2 seconds
- Poll: 0.3 seconds
- **Best for**: Complex tasks, detailed responses

**How to use**: Click any preset button to instantly apply those settings.

---

## History Management

### Saving Prompts
1. Enter your prompts in the text box
2. Click **💾 Save** button
3. Current prompts and settings are saved
4. Toast notification confirms: "✓ Saved to history"

### Viewing History
- History appears below in a scrollable list
- Shows item count badge (e.g., "5 items")
- Each item shows the first prompt and save date

### Loading from History
1. Find the history item you want
2. Click **Load** button
3. Prompts and settings are restored to the input fields
4. Prompt counter updates automatically

### Searching History
- Use the search box to filter saved histories
- Search is case-insensitive
- Searches through prompt text and titles

### Exporting History
1. Click **📥 Export** button
2. A JSON file downloads automatically
3. Filename includes timestamp: `prompt-queue-export-1234567890.json`
4. Toast shows: "✓ Exported X items"

### Importing History
1. Click **📤 Import** button
2. Select a previously exported JSON file
3. Imported items are merged with existing history
4. Toast shows: "✓ Imported X items"

### Clearing History
1. Click **🗑️ Clear all** button (only shows if history exists)
2. Confirm the action
3. All saved histories are deleted
4. Toast shows: "✓ History cleared"

---

## Troubleshooting

### Automation Not Starting
**Problem**: "Start Automation" button doesn't work
- ✓ Make sure you have ChatGPT, Gemini, Grok, or Claude open in the active tab
- ✓ Verify you've entered at least one prompt
- ✓ Check browser console for error messages (F12 → Console)

### Prompts Not Being Sent
**Problem**: Prompts are entered but not sending
- ✓ Check if the chat input is visible on the page
- ✓ Try clicking in the chat input first to focus it
- ✓ Increase "Max Wait" time if responses are slow
- ✓ Disable "Enable Max Wait Timeout" for very long tasks

### Automation Stops Prematurely
**Problem**: Automation stops before all prompts are sent
- ✓ Increase "Max Wait (seconds)" value
- ✓ Increase "Stable (seconds)" if responses are still being generated
- ✓ Check browser console for error messages
- ✓ Disable "Enable Max Wait Timeout" if getting timeout errors

### Responses Not Complete
**Problem**: Next prompt sends before response is fully generated
- ✓ Increase "Stable (seconds)" to wait longer for changes
- ✓ Decrease "Poll Interval" for more frequent checks
- ✓ Disable "Enable Max Wait Timeout" for complex responses

### Buttons Disabled After Automation
**Problem**: Buttons remain disabled after automation completes
- ✓ Click "Stop" button to reset state
- ✓ Refresh the popup (close and reopen)
- ✓ Uncheck "Disable buttons during automation" if this is annoying

### Export/Import Not Working
**Problem**: Can't export or import histories
- ✓ Make sure you have saved histories first
- ✓ For import, verify the JSON file is valid (from a previous export)
- ✓ Check file permissions
- ✓ Try a different browser if issue persists

---

## FAQ

### Q: Can I use this on multiple AI platforms?
**A**: Yes! The extension supports:
- ChatGPT (chat.openai.com, chatgpt.com)
- Google Gemini (gemini.google.com)
- Grok (grok.x.ai)
- Claude (claude.ai)

### Q: Will my prompts be saved if I close the browser?
**A**: Yes! Saved histories are stored locally in your browser and persist across sessions.

### Q: Can I edit saved prompts?
**A**: Currently, you can load a history item and then manually edit the prompts. To save changes, click "Save" again.

### Q: What's the maximum number of prompts I can queue?
**A**: There's no hard limit, but practical limit is around 100-200 prompts depending on your system.

### Q: Can I pause and resume automation?
**A**: Not directly, but you can click "Stop" and then "Start Automation" again. The extension will continue from where it left off.

### Q: Why is my automation timing out?
**A**: Common reasons:
- Response is taking longer than "Max Wait" time
- AI is rate-limited or overloaded
- Internet connection is slow
- Try increasing "Max Wait" or disabling the timeout

### Q: Can I use this extension in incognito mode?
**A**: Yes, but histories won't be saved between sessions (incognito data is cleared).

### Q: How do I know if a prompt was successfully processed?
**A**: 
- Status shows "Running prompt X of Y"
- Progress bar advances
- Toast notification shows success/error
- Check the AI chat window for the response

### Q: Can I customize the timing for specific prompts?
**A**: Currently, all prompts use the same timing settings. You can use presets or manually adjust settings before starting.

### Q: What happens if the AI returns an error?
**A**: The extension will:
- Log the error in console
- Show error status
- Continue with the next prompt
- You can check the chat window to see what went wrong

### Q: Can I export my settings?
**A**: Settings are saved with each history item. When you export history, settings are included in the JSON file.

### Q: Is my data sent to any server?
**A**: No! Everything runs locally in your browser. No data is sent to external servers.

### Q: Can I use this with API keys or custom models?
**A**: The extension works with the web interfaces. It doesn't directly support API calls, but you can use it with any web-based AI platform.

### Q: How do I report a bug?
**A**: 
- Check the browser console (F12 → Console) for error messages
- Note the exact steps to reproduce
- Check if the issue occurs with different AI platforms
- Report on the GitHub repository

### Q: Can I contribute to the extension?
**A**: Yes! The project is open-source. Check the GitHub repository for contribution guidelines.

### Q: What if I accidentally clear my history?
**A**: Unfortunately, cleared history cannot be recovered. However, if you exported your history as JSON, you can import it again.

### Q: Can I run multiple automations simultaneously?
**A**: No, the extension processes one automation at a time. You can queue multiple prompt sets and run them sequentially.

### Q: Why does the system prompt sometimes not appear?
**A**: 
- Make sure "Prepend to each prompt" is checked
- Verify the system prompt text is not empty
- Some AI platforms may format system prompts differently

### Q: Can I use this on mobile?
**A**: No, Chrome extensions only work on desktop Chrome. Mobile browsers don't support extensions.

---

## Tips & Best Practices

### 💡 Pro Tips

1. **Use Presets**: Start with a preset that matches your task type
2. **Test First**: Run a single prompt to verify timing before running many
3. **Monitor First Run**: Watch the first automation to ensure settings are correct
4. **Save Often**: Save successful prompt chains for reuse
5. **Export Regularly**: Backup important histories as JSON files
6. **Use System Prompt**: Set a system prompt to ensure consistent response style
7. **Check Stability**: If responses seem incomplete, increase "Stable" seconds
8. **Disable Timeout for Long Tasks**: Complex tasks may need "Enable Max Wait Timeout" disabled

### ⚠️ Important Notes

- The extension simulates user interactions, so it may not work if the AI platform changes its UI
- Some AI platforms have rate limits; very long queues may hit these limits
- The extension respects the AI platform's terms of service; use responsibly
- Keep your browser window active for best results (some platforms behave differently in background tabs)

---

## Keyboard Shortcuts

Currently, the extension doesn't have keyboard shortcuts, but you can:
- Use Tab to navigate between inputs
- Use Enter to focus buttons
- Use Ctrl+A to select all text in textareas

---

## Support

For issues, questions, or suggestions:
1. Check this guide and FAQ first
2. Check the browser console for error messages
3. Try the troubleshooting section
4. Report issues on the GitHub repository

---

**Last Updated**: November 2025
**Version**: 1.0
