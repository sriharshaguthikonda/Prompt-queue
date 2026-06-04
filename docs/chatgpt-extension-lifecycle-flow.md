# ChatGPT + Extension Lifecycle Flow

Editable source: this file is plain Markdown. The diagram is Mermaid text, so update the nodes and edges when ChatGPT DOM states or extension automation states change.

## Flowchart

```mermaid
flowchart TD
  subgraph UI["Extension side panel"]
    U1["User queues prompts"]
    U2["Settings choose lifecycle controls"]
    U3["Debug panel shows selector health, dry-run, per-step logs"]
  end

  subgraph BG["Background service worker"]
    B1["Start automation"]
    B2["Acquire cross-tab send lease"]
    B3["Inject or refresh content modules"]
    B4["Dispatch SEND_PROMPT_CURRENT"]
    B5["Release send lease after PROMPT_SUBMITTED"]
    B6["Advance queue on RESPONSE_COMPLETE"]
    B7["Retry, pause, stop, or finish"]
  end

  subgraph CS["Content runner"]
    C1["Detect site and load target settings"]
    C2["Resolve prompt, send, stop, watched selectors"]
    C3["Wait for current stream to stop"]
    C4["Find visible composer div#prompt-textarea"]
    C5["Populate composer without page reload"]
    C6["Verify visible input text"]
    C7["Wait configurable post-populate delay"]
    C8["Wait ChatGPT pre-send quiet window"]
    C9["Click button#composer-submit-button"]
    C10["Send PROMPT_SUBMITTED"]
    C11["Verify stream started or prompt rendered"]
    C12["Wait for assistant completion"]
    C13["Send RESPONSE_COMPLETE"]
  end

  subgraph CG["ChatGPT page lifecycle"]
    G1["Composer idle or disabled"]
    G2["Composer has draft"]
    G3["Composer action is send-ready"]
    G4["Composer action is stop-active"]
    G5["Assistant response streams"]
    G6["Assistant response stable"]
    G7["Response actions appear: Copy, Good response, Bad response"]
  end

  U1 --> B1
  U2 --> B1
  U3 <--> C2
  B1 --> B2 --> B3 --> B4 --> C1
  C1 --> C2 --> C3 --> C4 --> C5 --> C6 --> C7 --> C8
  C8 --> G3
  G1 --> G2 --> G3
  C9 --> G4 --> G5 --> G6 --> G7
  C9 --> C10 --> B5
  C10 --> C11 --> C12
  G7 --> C12
  C12 --> C13 --> B6
  B6 --> B2
  B6 --> B7
```

## Lifecycle Controls

- `targetSelectors.promptInput`: controls how the visible composer is found.
- `targetSelectors.sendButton`: controls the send action target when default candidates drift.
- `targetSelectors.stopButton`: controls active generation detection, but `button#composer-submit-button` must be interpreted by role, not by stale attributes alone.
- `targetSelectors.watchedElement`: controls response-action completion evidence, normally copy/good/bad response buttons.
- `enableWatchedElementGate`: requires new response-action evidence before completion.
- `postPopulateDelayMinMs` / `postPopulateDelayMaxMs`: controls the pause between visible population and send.
- `crossTabSendLockMinWaitMs` / `crossTabSendLockMaxWaitMs`: controls random wait before another tab may click send.
- `perStepConsoleLogging`: emits sanitized lifecycle step logs.
- `dryRunPopulateOnly`: populates the composer but does not send.

## Current ChatGPT Invariants

- Visible composer: `div#prompt-textarea`.
- Composer action: `button#composer-submit-button`.
- The composer action can be send-ready, stop-active, disabled, or stale-mixed.
- Completion should rely on stable assistant response plus response actions, not only on send button enabled state.
- Known response actions: `Copy response`, `Good response`, `Bad response`.
