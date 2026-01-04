/**
 * Unit Tests for Utility Functions
 * Tests for popup.js utility functions
 */

describe('Utility Functions', () => {
  
  describe('parsePrompts', () => {
    it('should parse single prompt', () => {
      const result = parsePrompts('Hello world');
      expect(result).toEqual(['Hello world']);
    });

    it('should honor custom separator', () => {
      const custom = '===';
      const text = `Prompt 1${custom}Prompt 2`;
      const result = parsePrompts(text, custom);
      expect(result).toEqual(['Prompt 1', 'Prompt 2']);
    });

    it('should treat literal \\n as newline when passed in', () => {
      const sep = '\\n\\n';
      const text = `Prompt 1${sep}Prompt 2`;
      const resolved = sep.replace(/\\n/g, '\n');
      const result = parsePrompts(text.replace(sep, resolved), resolved);
      expect(result).toEqual(['Prompt 1', 'Prompt 2']);
    });

    it('should parse multiple prompts', () => {
      const result = parsePrompts('Prompt 1\nPrompt 2\nPrompt 3');
      expect(result).toEqual(['Prompt 1', 'Prompt 2', 'Prompt 3']);
    });

    it('should handle empty lines', () => {
      const result = parsePrompts('Prompt 1\n\nPrompt 2');
      expect(result).toEqual(['Prompt 1', 'Prompt 2']);
    });

    it('should trim whitespace', () => {
      const result = parsePrompts('  Prompt 1  \n  Prompt 2  ');
      expect(result).toEqual(['Prompt 1', 'Prompt 2']);
    });

    it('should handle CRLF line endings', () => {
      const result = parsePrompts('Prompt 1\r\nPrompt 2\r\nPrompt 3');
      expect(result).toEqual(['Prompt 1', 'Prompt 2', 'Prompt 3']);
    });

    it('should return empty array for empty string', () => {
      const result = parsePrompts('');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace only', () => {
      const result = parsePrompts('   \n  \n  ');
      expect(result).toEqual([]);
    });
  });

  describe('secToMs', () => {
    it('should convert seconds to milliseconds', () => {
      expect(secToMs(1)).toBe(1000);
      expect(secToMs(2.5)).toBe(2500);
      expect(secToMs(0.5)).toBe(500);
    });

    it('should handle zero', () => {
      expect(secToMs(0)).toBe(0);
    });

    it('should return undefined for non-numbers', () => {
      expect(secToMs('abc')).toBeUndefined();
      expect(secToMs(null)).toBeUndefined();
      expect(secToMs(undefined)).toBeUndefined();
    });

    it('should return undefined for NaN', () => {
      expect(secToMs(NaN)).toBeUndefined();
    });

    it('should round to nearest integer', () => {
      expect(secToMs(1.234)).toBe(1234);
      expect(secToMs(1.567)).toBe(1567);
    });
  });

  describe('msToSec', () => {
    it('should convert milliseconds to seconds', () => {
      expect(msToSec(1000)).toBe(1);
      expect(msToSec(2500)).toBe(2.5);
      expect(msToSec(500)).toBe(0.5);
    });

    it('should handle zero', () => {
      expect(msToSec(0)).toBe(0);
    });

    it('should return empty string for non-numbers', () => {
      expect(msToSec('abc')).toBe('');
      expect(msToSec(null)).toBe('');
      expect(msToSec(undefined)).toBe('');
    });

    it('should return empty string for NaN', () => {
      expect(msToSec(NaN)).toBe('');
    });
  });

  describe('showToast', () => {
    let toastElement;

    beforeEach(() => {
      document.body.innerHTML = '<div id="toast" class="toast"></div>';
      toastElement = document.getElementById('toast');
    });

    afterEach(() => {
      document.body.innerHTML = '';
      jest.clearAllTimers();
    });

    it('should show toast with message', () => {
      jest.useFakeTimers();
      showToast('Test message', 'success');
      
      expect(toastElement.textContent).toBe('Test message');
      expect(toastElement.classList.contains('show')).toBe(true);
      expect(toastElement.classList.contains('success')).toBe(true);
    });

    it('should apply correct type class', () => {
      jest.useFakeTimers();
      
      showToast('Error', 'error');
      expect(toastElement.classList.contains('error')).toBe(true);
      
      showToast('Info', 'info');
      expect(toastElement.classList.contains('info')).toBe(true);
    });

    it('should auto-hide after duration', () => {
      jest.useFakeTimers();
      showToast('Test', 'success', 3000);
      
      expect(toastElement.classList.contains('show')).toBe(true);
      
      jest.advanceTimersByTime(3000);
      
      expect(toastElement.classList.contains('show')).toBe(false);
    });

    it('should use default duration of 3000ms', () => {
      jest.useFakeTimers();
      showToast('Test', 'success');
      
      jest.advanceTimersByTime(3000);
      
      expect(toastElement.classList.contains('show')).toBe(false);
    });
  });

  describe('setButtonsDisabled', () => {
    let button1, button2, checkbox;

    beforeEach(() => {
      document.body.innerHTML = `
        <input id="disableButtonsDuringAutomation" type="checkbox" checked />
        <button id="btn1">Button 1</button>
        <button id="btn2">Button 2</button>
      `;
      button1 = document.getElementById('btn1');
      button2 = document.getElementById('btn2');
      checkbox = document.getElementById('disableButtonsDuringAutomation');
    });

    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('should disable buttons when disabled=true and checkbox checked', () => {
      setButtonsDisabled(true);
      
      expect(button1.disabled).toBe(true);
      expect(button2.disabled).toBe(true);
    });

    it('should not disable buttons when checkbox unchecked', () => {
      checkbox.checked = false;
      setButtonsDisabled(true);
      
      expect(button1.disabled).toBe(false);
      expect(button2.disabled).toBe(false);
    });

    it('should enable buttons when disabled=false', () => {
      button1.disabled = true;
      button2.disabled = true;
      
      setButtonsDisabled(false);
      
      expect(button1.disabled).toBe(false);
      expect(button2.disabled).toBe(false);
    });
  });

  describe('showHistoryLoading', () => {
    let loading, history;

    beforeEach(() => {
      document.body.innerHTML = `
        <div id="historyLoading" class="history-loading hidden">
          <div class="skeleton"></div>
        </div>
        <div id="history" class="history-list"></div>
      `;
      loading = document.getElementById('historyLoading');
      history = document.getElementById('history');
    });

    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('should show loading skeleton', () => {
      showHistoryLoading(true);
      
      expect(loading.classList.contains('hidden')).toBe(false);
      expect(history.innerHTML).toBe('');
    });

    it('should hide loading skeleton', () => {
      loading.classList.remove('hidden');
      showHistoryLoading(false);
      
      expect(loading.classList.contains('hidden')).toBe(true);
    });

    it('should clear history when showing loading', () => {
      history.innerHTML = '<div>Old item</div>';
      showHistoryLoading(true);
      
      expect(history.innerHTML).toBe('');
    });
  });

  describe('setStatus', () => {
    let statusElement;

    beforeEach(() => {
      document.body.innerHTML = `
        <div id="status">
          <span class="status-badge status-idle">
            <span class="status-dot idle"></span>
            <span>Idle</span>
          </span>
        </div>
      `;
      statusElement = document.getElementById('status');
    });

    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('should set status text and type', () => {
      setStatus('Running', 'running');
      
      const badge = statusElement.querySelector('.status-badge');
      expect(badge.classList.contains('status-running')).toBe(true);
      expect(statusElement.textContent).toContain('Running');
    });

    it('should update status dot class', () => {
      setStatus('Error', 'error');
      
      const dot = statusElement.querySelector('.status-dot');
      expect(dot.classList.contains('error')).toBe(true);
    });

    it('should handle idle status', () => {
      setStatus('Idle', 'idle');
      
      const badge = statusElement.querySelector('.status-badge');
      expect(badge.classList.contains('status-idle')).toBe(true);
    });
  });

  describe('setProgress', () => {
    let progressBar;

    beforeEach(() => {
      document.body.innerHTML = `
        <div class="progress">
          <div id="progressBar" class="bar"></div>
        </div>
      `;
      progressBar = document.getElementById('progressBar');
    });

    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('should set progress percentage', () => {
      setProgress(5, 10);
      
      expect(progressBar.style.width).toBe('50%');
    });

    it('should handle 0 progress', () => {
      setProgress(0, 10);
      
      expect(progressBar.style.width).toBe('0%');
    });

    it('should handle 100% progress', () => {
      setProgress(10, 10);
      
      expect(progressBar.style.width).toBe('100%');
    });

    it('should cap at 100%', () => {
      setProgress(15, 10);
      
      expect(progressBar.style.width).toBe('100%');
    });

    it('should handle zero total', () => {
      setProgress(0, 0);
      
      // Should not crash, width should remain unchanged
      expect(progressBar.style.width).toBe('');
    });
  });
});
