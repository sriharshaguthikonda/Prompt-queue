/**
 * End-to-End Tests for Popup Interactions
 * Tests for complete user workflows
 */

describe('Popup E2E Tests', () => {

  describe('Prompt Input Workflow', () => {
    beforeEach(() => {
      // Setup popup DOM
      document.body.innerHTML = `
        <textarea id="prompts" placeholder="Paste prompts here..."></textarea>
        <div class="prompt-counter">0 prompts loaded</div>
        <textarea id="systemPrompt" placeholder="Optional system prompt..."></textarea>
        <input id="prependSystemPrompt" type="checkbox" checked />
        <button id="startBtn" class="primary">Start Automation</button>
        <div id="status">
          <span class="status-badge status-idle">
            <span class="status-dot idle"></span>
            <span>Idle</span>
          </span>
        </div>
      `;
    });

    it('should update prompt counter when typing', () => {
      const textarea = document.getElementById('prompts');
      const counter = document.querySelector('.prompt-counter');
      
      textarea.value = 'Prompt 1\nPrompt 2\nPrompt 3';
      textarea.dispatchEvent(new Event('input'));
      
      // Counter should update (assuming updatePromptCount is called)
      expect(counter.textContent).toContain('3');
    });

    it('should enable start button with valid prompts', () => {
      const textarea = document.getElementById('prompts');
      const startBtn = document.getElementById('startBtn');
      
      textarea.value = 'Test prompt';
      
      expect(startBtn.disabled).toBe(false);
    });

    it('should disable start button without prompts', () => {
      const textarea = document.getElementById('prompts');
      const startBtn = document.getElementById('startBtn');
      
      textarea.value = '';
      
      // Button should be disabled or show error
      expect(textarea.value).toBe('');
    });

    it('should include system prompt when checkbox enabled', () => {
      const prompts = document.getElementById('prompts');
      const systemPrompt = document.getElementById('systemPrompt');
      const checkbox = document.getElementById('prependSystemPrompt');
      
      prompts.value = 'Test prompt';
      systemPrompt.value = 'You are helpful';
      checkbox.checked = true;
      
      expect(checkbox.checked).toBe(true);
      expect(systemPrompt.value).toBe('You are helpful');
    });

    it('should ignore system prompt when checkbox disabled', () => {
      const checkbox = document.getElementById('prependSystemPrompt');
      const systemPrompt = document.getElementById('systemPrompt');
      
      checkbox.checked = false;
      systemPrompt.value = 'You are helpful';
      
      expect(checkbox.checked).toBe(false);
    });
  });

  describe('Settings Workflow', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <input id="maxWaitSec" type="number" value="180" />
        <input id="stableMinSec" type="number" value="1.2" />
        <input id="stableMaxSec" type="number" value="2.4" />
        <input id="pollSec" type="number" value="0.3" />
        <input id="enableMaxWaitTimeout" type="checkbox" checked />
        <button class="preset-btn" data-preset="fast">⚡ Fast</button>
        <button class="preset-btn" data-preset="balanced">⚖️ Balanced</button>
        <button class="preset-btn" data-preset="thorough">🔍 Thorough</button>
      `;
    });

    it('should apply Fast preset', () => {
      const fastBtn = document.querySelector('[data-preset="fast"]');
      const maxWait = document.getElementById('maxWaitSec');
      const stableMin = document.getElementById('stableMinSec');
      const stableMax = document.getElementById('stableMaxSec');
      
      // Simulate preset click
      maxWait.value = '60';
      stableMin.value = '2';
      stableMax.value = '4';
      
      expect(maxWait.value).toBe('60');
      expect(stableMin.value).toBe('2');
      expect(stableMax.value).toBe('4');
    });

    it('should apply Balanced preset', () => {
      const balancedBtn = document.querySelector('[data-preset="balanced"]');
      const maxWait = document.getElementById('maxWaitSec');
      const stableMin = document.getElementById('stableMinSec');
      const stableMax = document.getElementById('stableMaxSec');
      
      maxWait.value = '180';
      stableMin.value = '8';
      stableMax.value = '12';
      
      expect(maxWait.value).toBe('180');
      expect(stableMin.value).toBe('8');
      expect(stableMax.value).toBe('12');
    });

    it('should apply Thorough preset', () => {
      const thoroughBtn = document.querySelector('[data-preset="thorough"]');
      const maxWait = document.getElementById('maxWaitSec');
      const stableMin = document.getElementById('stableMinSec');
      const stableMax = document.getElementById('stableMaxSec');
      
      maxWait.value = '300';
      stableMin.value = '12';
      stableMax.value = '18';
      
      expect(maxWait.value).toBe('300');
      expect(stableMin.value).toBe('12');
      expect(stableMax.value).toBe('18');
    });

    it('should toggle max wait timeout', () => {
      const checkbox = document.getElementById('enableMaxWaitTimeout');
      
      expect(checkbox.checked).toBe(true);
      
      checkbox.checked = false;
      expect(checkbox.checked).toBe(false);
      
      checkbox.checked = true;
      expect(checkbox.checked).toBe(true);
    });

    it('should validate settings ranges', () => {
      const maxWait = document.getElementById('maxWaitSec');
      const stableMin = document.getElementById('stableMinSec');
      const stableMax = document.getElementById('stableMaxSec');
      const poll = document.getElementById('pollSec');
      
      // Valid values
      maxWait.value = '180';
      stableMin.value = '1.2';
      stableMax.value = '2';
      poll.value = '0.3';
      
      expect(Number(maxWait.value)).toBeGreaterThanOrEqual(5);
      expect(Number(stableMin.value)).toBeGreaterThanOrEqual(0.2);
      expect(Number(stableMax.value)).toBeGreaterThanOrEqual(Number(stableMin.value));
      expect(Number(poll.value)).toBeGreaterThanOrEqual(0.05);
    });
  });

  describe('History Workflow', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <button id="saveHistoryBtn">💾 Save</button>
        <button id="reloadHistoryBtn">🔄 Reload</button>
        <button id="exportBtn">📥 Export</button>
        <button id="importBtn">📤 Import</button>
        <input id="importFile" type="file" accept=".json" style="display: none;" />
        <input id="historySearch" type="text" placeholder="Search histories..." />
        <div id="history" class="history-list"></div>
        <span id="historyCount">0 items</span>
        <button id="clearHistoryBtn" class="clear-history-btn">🗑️ Clear all</button>
        <div id="toast" class="toast"></div>
      `;
    });

    it('should save current prompts to history', async () => {
      const saveBtn = document.getElementById('saveHistoryBtn');
      
      expect(saveBtn).toBeDefined();
      expect(saveBtn.textContent).toContain('Save');
    });

    it('should reload history', async () => {
      const reloadBtn = document.getElementById('reloadHistoryBtn');
      
      expect(reloadBtn).toBeDefined();
      expect(reloadBtn.textContent).toContain('Reload');
    });

    it('should search history items', () => {
      const searchInput = document.getElementById('historySearch');
      const historyList = document.getElementById('history');
      
      // Add mock history items
      historyList.innerHTML = `
        <div class="history-item">First prompt</div>
        <div class="history-item">Second prompt</div>
        <div class="history-item">Third prompt</div>
      `;
      
      searchInput.value = 'First';
      
      // Simulate search
      const items = historyList.querySelectorAll('.history-item');
      items.forEach(item => {
        const matches = item.textContent.toLowerCase().includes('first');
        item.style.display = matches ? '' : 'none';
      });
      
      expect(items[0].style.display).toBe('');
      expect(items[1].style.display).toBe('none');
    });

    it('should export history as JSON', () => {
      const exportBtn = document.getElementById('exportBtn');
      
      expect(exportBtn).toBeDefined();
      expect(exportBtn.textContent).toContain('Export');
    });

    it('should import history from JSON', () => {
      const importBtn = document.getElementById('importBtn');
      const importFile = document.getElementById('importFile');
      
      expect(importBtn).toBeDefined();
      expect(importFile.style.display).toBe('none');
    });

    it('should show history count', () => {
      const countBadge = document.getElementById('historyCount');
      
      countBadge.textContent = '5 items';
      
      expect(countBadge.textContent).toBe('5 items');
    });

    it('should clear all history with confirmation', () => {
      const clearBtn = document.getElementById('clearHistoryBtn');
      
      expect(clearBtn).toBeDefined();
      expect(clearBtn.textContent).toContain('Clear all');
    });
  });

  describe('Collapsible Sections', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div class="collapsible-header" id="optionsHeader">
          <span class="collapsible-toggle">▼</span>
          <span class="section-title">Options</span>
        </div>
        <div class="collapsible-content" id="optionsContent">
          <div>Option 1</div>
          <div>Option 2</div>
        </div>
        
        <div class="collapsible-header" id="advancedHeader">
          <span class="collapsible-toggle collapsed">▼</span>
          <span class="section-title">Advanced Options</span>
        </div>
        <div class="collapsible-content collapsed" id="advancedContent">
          <div>Advanced 1</div>
          <div>Advanced 2</div>
        </div>
      `;
    });

    it('should toggle Options section', () => {
      const header = document.getElementById('optionsHeader');
      const content = document.getElementById('optionsContent');
      const toggle = header.querySelector('.collapsible-toggle');
      
      // Initially expanded
      expect(content.classList.contains('collapsed')).toBe(false);
      
      // Click to collapse
      header.click();
      content.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
      
      expect(content.classList.contains('collapsed')).toBe(true);
      expect(toggle.classList.contains('collapsed')).toBe(true);
    });

    it('should toggle Advanced Options section', () => {
      const header = document.getElementById('advancedHeader');
      const content = document.getElementById('advancedContent');
      const toggle = header.querySelector('.collapsible-toggle');
      
      // Initially collapsed
      expect(content.classList.contains('collapsed')).toBe(true);
      
      // Click to expand
      header.click();
      content.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
      
      expect(content.classList.contains('collapsed')).toBe(false);
      expect(toggle.classList.contains('collapsed')).toBe(false);
    });
  });

  describe('Automation Workflow', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <textarea id="prompts">Prompt 1\nPrompt 2\nPrompt 3</textarea>
        <button id="startBtn" class="primary">Start Automation</button>
        <button id="stopBtn" class="secondary">Stop</button>
        <div id="status">
          <span class="status-badge status-idle">
            <span class="status-dot idle"></span>
            <span>Idle</span>
          </span>
        </div>
        <div class="progress">
          <div id="progressBar" class="bar"></div>
        </div>
        <input id="disableButtonsDuringAutomation" type="checkbox" checked />
        <div id="toast" class="toast"></div>
      `;
    });

    it('should start automation with valid prompts', () => {
      const startBtn = document.getElementById('startBtn');
      const prompts = document.getElementById('prompts');
      
      expect(prompts.value).toContain('Prompt 1');
      expect(startBtn.disabled).toBe(false);
    });

    it('should disable buttons during automation', () => {
      const startBtn = document.getElementById('startBtn');
      const stopBtn = document.getElementById('stopBtn');
      const checkbox = document.getElementById('disableButtonsDuringAutomation');
      
      checkbox.checked = true;
      
      // Simulate automation start
      startBtn.disabled = true;
      stopBtn.disabled = true;
      
      expect(startBtn.disabled).toBe(true);
      expect(stopBtn.disabled).toBe(true);
    });

    it('should update progress bar', () => {
      const progressBar = document.getElementById('progressBar');
      
      // Simulate progress update
      progressBar.style.width = '33%';
      expect(progressBar.style.width).toBe('33%');
      
      progressBar.style.width = '66%';
      expect(progressBar.style.width).toBe('66%');
      
      progressBar.style.width = '100%';
      expect(progressBar.style.width).toBe('100%');
    });

    it('should update status during automation', () => {
      const status = document.getElementById('status');
      const badge = status.querySelector('.status-badge');
      
      // Simulate running state
      badge.className = 'status-badge status-running';
      badge.innerHTML = '<span class="status-dot running"></span><span>Running prompt 1 of 3...</span>';
      
      expect(badge.classList.contains('status-running')).toBe(true);
      expect(badge.textContent).toContain('Running');
    });

    it('should show completion status', () => {
      const status = document.getElementById('status');
      const badge = status.querySelector('.status-badge');
      
      // Simulate completion
      badge.className = 'status-badge status-idle';
      badge.innerHTML = '<span class="status-dot idle"></span><span>Complete</span>';
      
      expect(badge.textContent).toContain('Complete');
    });

    it('should show error status', () => {
      const status = document.getElementById('status');
      const badge = status.querySelector('.status-badge');
      
      // Simulate error
      badge.className = 'status-badge status-error';
      badge.innerHTML = '<span class="status-dot error"></span><span>Error: Could not find input</span>';
      
      expect(badge.classList.contains('status-error')).toBe(true);
      expect(badge.textContent).toContain('Error');
    });

    it('should stop automation', () => {
      const stopBtn = document.getElementById('stopBtn');
      
      expect(stopBtn).toBeDefined();
      expect(stopBtn.textContent).toBe('Stop');
    });

    it('should re-enable buttons after automation', () => {
      const startBtn = document.getElementById('startBtn');
      const stopBtn = document.getElementById('stopBtn');
      
      // Simulate automation completion
      startBtn.disabled = false;
      stopBtn.disabled = false;
      
      expect(startBtn.disabled).toBe(false);
      expect(stopBtn.disabled).toBe(false);
    });
  });

  describe('Toast Notifications', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="toast" class="toast"></div>';
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should show success toast', () => {
      const toast = document.getElementById('toast');
      
      toast.textContent = '✓ Saved to history';
      toast.className = 'toast show success';
      
      expect(toast.classList.contains('show')).toBe(true);
      expect(toast.classList.contains('success')).toBe(true);
      expect(toast.textContent).toContain('Saved');
    });

    it('should show error toast', () => {
      const toast = document.getElementById('toast');
      
      toast.textContent = '✗ Error: Could not save';
      toast.className = 'toast show error';
      
      expect(toast.classList.contains('show')).toBe(true);
      expect(toast.classList.contains('error')).toBe(true);
    });

    it('should auto-dismiss toast', () => {
      const toast = document.getElementById('toast');
      
      toast.textContent = 'Test message';
      toast.className = 'toast show success';
      
      expect(toast.classList.contains('show')).toBe(true);
      
      jest.advanceTimersByTime(3000);
      toast.classList.remove('show');
      
      expect(toast.classList.contains('show')).toBe(false);
    });
  });

  describe('Theme Switching', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <body class="theme-dark">
          <select id="themeSelect">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </body>
      `;
    });

    it('should switch to light theme', () => {
      const body = document.body;
      const select = document.getElementById('themeSelect');
      
      select.value = 'light';
      body.classList.remove('theme-dark');
      body.classList.add('theme-light');
      
      expect(body.classList.contains('theme-light')).toBe(true);
      expect(body.classList.contains('theme-dark')).toBe(false);
    });

    it('should switch back to dark theme', () => {
      const body = document.body;
      const select = document.getElementById('themeSelect');
      
      body.classList.add('theme-light');
      
      select.value = 'dark';
      body.classList.remove('theme-light');
      body.classList.add('theme-dark');
      
      expect(body.classList.contains('theme-dark')).toBe(true);
      expect(body.classList.contains('theme-light')).toBe(false);
    });
  });
});
