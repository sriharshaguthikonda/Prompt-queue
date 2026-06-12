# ChatGPT + Extension Lifecycle Flow

Editable source: this file is plain Markdown. The diagram is Mermaid text, so update the nodes and edges when ChatGPT DOM states, monitored signals, or extension automation states change.

## Flowchart

```mermaid
flowchart TD
  subgraph UI["Extension UI"]
    U1["Popup / side panel"]
    U2["Queue prompt items"]
    U3["Choose lifecycle controls"]
    U4["Show selector health, dry-run, step logs"]
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
    C2["Resolve prompt, send, stop, and watched selectors"]
    C3["Wait for current stream to stop"]
    C4["Find visible composer"]
    C5["Populate composer without page reload"]
    C6["Verify visible input text"]
    C7["Wait configurable post-populate delay"]
    C8["Wait ChatGPT pre-send quiet window"]
    C9["Click composer action button"]
    C10["Send PROMPT_SUBMITTED"]
    C11["Capture response text and stability"]
    C12["Wait for assistant completion"]
    C13["Send RESPONSE_COMPLETE"]
  end

  subgraph DX["Sanitized lifecycle diagnostics"]
    X1["Emit step change events with no raw prompt or response text"]
    X2["Report monitored element names, selector state, and blocker reason names"]
    X3["Report timing windows, stream start/stop, and completion decision"]
    X4["Expose debug-panel status for selector health and lifecycle behavior"]
  end

  subgraph CG["ChatGPT page lifecycle"]
    G1["Composer idle or disabled"]
    G2["Composer has draft"]
    G3["Send-ready composer action"]
    G4["Stop-active composer action"]
    G5["Assistant response streams"]
    G6["Assistant response text stabilizes"]
    G7["Response actions appear"]
  end

  subgraph GS["Monitored ChatGPT elements and signals"]
    M1["Composer surface"]
    M2["Composer action control"]
    M3["Button and role signals"]
    M4["Activity blockers"]
    M5["Response action markers"]
    M6["Response stability"]
    M7["Watch gate"]
    M8["Queue state"]
    M9["Stream signals"]
  end

  U1 --> U2 --> U3 --> U4 --> B1
  U4 <--> C2
  B1 --> B2 --> B3 --> B4 --> C1
  C1 --> M8
  C1 --> M1
  C1 --> M2
  C1 --> M3
  C1 --> M4
  C1 --> M5
  C1 --> M6
  C1 --> M7
  C2 --> C3 --> C4 --> C5 --> C6 --> C7 --> C8
  C4 --> M1
  C5 --> M1
  C6 --> M1
  C8 --> G3
  C8 --> M9
  G1 --> G2 --> G3
  M2 --> G3
  M3 --> G3
  C9 --> G4 --> G5 --> G6 --> G7
  C9 --> C10 --> B5
  C10 --> C11 --> M6
  C11 --> C12
  G5 --> M4
  G6 --> M6
  G7 --> M5
  M5 -->|"stable response + no stop-active"| C12
  G7 --> C12
  C12 --> C13 --> B6
  B6 --> B2
  B6 --> B7
  M7 --> C12
  M8 --> B6
  M4 --> X2
  M5 --> X2
  M6 --> X3
  M7 --> X2
  M8 --> X1
  M9 --> X3
  B4 --> X1
  B5 --> X3
  B6 --> X4
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
- Future settings should also let the user control which monitored signals participate in gating, and how aggressive the lifecycle behavior should be, without changing code.

## Exact Selectors

- Composer surface: `div#prompt-textarea`, `textarea` fallback.
- Composer action control: `button#composer-submit-button`, `button[data-testid="send-button"]`, send-label variants.
- Button and role signals: `aria-label`, `title`, `data-testid`, `disabled`, `aria-disabled`, `role`.
- Response action markers: `button[data-testid="copy-turn-action-button"]`, `button[aria-label="Copy response"]`, `button[aria-label="Good response"]`, `button[aria-label="Bad response"]`.

## Current ChatGPT Invariants

- Visible composer is the `div#prompt-textarea` editor when present.
- Composer action is the current submit/stop control.
- The composer action can be send-ready, stop-active, disabled, or stale-mixed, so label/role checks matter more than raw selector presence.
- Loading shimmer and thinking indicators block while live, but stale tail-turn indicators stop blocking when stable response text and copy/good/bad action evidence exist and the composer is no longer stop-active.
- Active tool status and confirm dialogs remain hard blockers.
- Completion should rely on stable assistant response text plus response actions, not only on send button enabled state.
- Known response actions: copy-turn action button, `Copy response`, `Good response`, `Bad response`.
- Queue lifecycle tracks the current prompt, prompt-submitted handoff, and completion handoff back to the background service worker.
- Diagnostics must stay sanitized and detailed enough to explain stop/send composer role, response-action evidence, loading shimmer, thinking/tool status, confirm dialog, watched selector state, pre-send quiet window, stream start/stop, and completion decision without exposing raw content.
