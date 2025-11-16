# Testing Guide

This document describes how to run and write tests for the Auto-Prompt extension.

## Table of Contents
1. [Setup](#setup)
2. [Running Tests](#running-tests)
3. [Test Structure](#test-structure)
4. [Writing Tests](#writing-tests)
5. [Coverage](#coverage)

---

## Setup

### Prerequisites
- Node.js 14+ installed
- npm or yarn package manager

### Installation

1. Install dependencies:
```bash
npm install --save-dev jest @testing-library/dom jsdom
```

2. Verify Jest is installed:
```bash
npx jest --version
```

---

## Running Tests

### Run All Tests
```bash
npm test
```

### Run Specific Test File
```bash
npm test unit.test.js
npm test integration.test.js
npm test e2e.test.js
```

### Run Tests in Watch Mode
```bash
npm test -- --watch
```

### Run Tests with Coverage
```bash
npm test -- --coverage
```

### Run Tests with Verbose Output
```bash
npm test -- --verbose
```

---

## Test Structure

### Unit Tests (`unit.test.js`)
Tests for individual utility functions in isolation.

**Functions tested:**
- `parsePrompts()` - Parse prompt text into array
- `secToMs()` - Convert seconds to milliseconds
- `msToSec()` - Convert milliseconds to seconds
- `showToast()` - Display toast notifications
- `setButtonsDisabled()` - Disable/enable buttons
- `showHistoryLoading()` - Show/hide loading skeleton
- `setStatus()` - Update status display
- `setProgress()` - Update progress bar

**Example:**
```javascript
describe('parsePrompts', () => {
  it('should parse multiple prompts', () => {
    const result = parsePrompts('Prompt 1\nPrompt 2');
    expect(result).toEqual(['Prompt 1', 'Prompt 2']);
  });
});
```

### Integration Tests (`integration.test.js`)
Tests for content script functions and their interactions.

**Functions tested:**
- `detectSite()` - Detect AI platform
- `isButtonEnabled()` - Check button state
- `waitForStreamsToStop()` - Wait for streaming to complete
- `waitForCompletion()` - Wait for response completion
- Message listener - Handle Chrome messages
- `setTextInInput()` - Set input text
- `clickSend()` - Click send button

**Example:**
```javascript
describe('detectSite', () => {
  it('should detect ChatGPT', () => {
    window.location.href = 'https://chat.openai.com/c/abc123';
    const site = detectSite();
    expect(site).toBe('chatgpt');
  });
});
```

### E2E Tests (`e2e.test.js`)
Tests for complete user workflows and interactions.

**Workflows tested:**
- Prompt input and counter update
- Settings and presets
- History management (save, load, search, export, import)
- Collapsible sections
- Automation workflow
- Toast notifications
- Theme switching

**Example:**
```javascript
describe('Prompt Input Workflow', () => {
  it('should update prompt counter when typing', () => {
    const textarea = document.getElementById('prompts');
    textarea.value = 'Prompt 1\nPrompt 2\nPrompt 3';
    textarea.dispatchEvent(new Event('input'));
    
    expect(counter.textContent).toContain('3');
  });
});
```

---

## Writing Tests

### Test Template

```javascript
describe('Feature Name', () => {
  beforeEach(() => {
    // Setup before each test
    document.body.innerHTML = '<div id="test"></div>';
  });

  afterEach(() => {
    // Cleanup after each test
    document.body.innerHTML = '';
  });

  it('should do something', () => {
    // Arrange
    const element = document.getElementById('test');
    
    // Act
    element.textContent = 'Hello';
    
    // Assert
    expect(element.textContent).toBe('Hello');
  });
});
```

### Common Assertions

```javascript
// Equality
expect(value).toBe(expectedValue);
expect(array).toEqual([1, 2, 3]);

// Truthiness
expect(value).toBeTruthy();
expect(value).toBeFalsy();

// Numbers
expect(value).toBeGreaterThan(5);
expect(value).toBeLessThan(10);

// Strings
expect(text).toContain('substring');
expect(text).toMatch(/regex/);

// DOM
expect(element.classList.contains('class')).toBe(true);
expect(element.disabled).toBe(false);

// Async
await expect(promise).rejects.toThrow();
await expect(promise).resolves.toBe(value);
```

### Testing Async Code

```javascript
it('should handle async operations', async () => {
  const result = await someAsyncFunction();
  expect(result).toBe(expectedValue);
});

it('should handle promises', () => {
  return somePromise().then(result => {
    expect(result).toBe(expectedValue);
  });
});
```

### Testing Timers

```javascript
it('should handle timers', () => {
  jest.useFakeTimers();
  
  const callback = jest.fn();
  setTimeout(callback, 1000);
  
  jest.advanceTimersByTime(1000);
  
  expect(callback).toHaveBeenCalled();
  
  jest.useRealTimers();
});
```

### Testing DOM Events

```javascript
it('should handle click events', () => {
  const button = document.createElement('button');
  const callback = jest.fn();
  
  button.addEventListener('click', callback);
  button.click();
  
  expect(callback).toHaveBeenCalled();
});
```

### Mocking Functions

```javascript
it('should mock chrome API', () => {
  chrome.runtime.sendMessage = jest.fn((msg, cb) => {
    cb({ ok: true });
  });
  
  chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
    expect(response.ok).toBe(true);
  });
  
  expect(chrome.runtime.sendMessage).toHaveBeenCalled();
});
```

---

## Coverage

### View Coverage Report
```bash
npm test -- --coverage
```

### Coverage Thresholds
The project aims for:
- **Statements**: 80%
- **Branches**: 75%
- **Functions**: 80%
- **Lines**: 80%

### Generate HTML Coverage Report
```bash
npm test -- --coverage --coverageReporters=html
```

Then open `coverage/index.html` in your browser.

---

## Best Practices

### ✅ Do's
- Write descriptive test names
- Test one thing per test
- Use `beforeEach` and `afterEach` for setup/cleanup
- Mock external dependencies (Chrome API)
- Test both happy path and error cases
- Use meaningful variable names
- Keep tests independent

### ❌ Don'ts
- Don't test implementation details
- Don't make tests dependent on each other
- Don't use `setTimeout` without mocking
- Don't test third-party libraries
- Don't skip error cases
- Don't create overly complex tests

---

## Troubleshooting

### Tests Not Running
```bash
# Clear Jest cache
npm test -- --clearCache

# Reinstall dependencies
rm -rf node_modules
npm install
```

### Timeout Errors
```javascript
// Increase timeout for slow tests
jest.setTimeout(10000);

// Or in test
it('slow test', async () => {
  // test code
}, 10000);
```

### DOM Not Updating
```javascript
// Make sure to dispatch events
element.value = 'new value';
element.dispatchEvent(new Event('input'));
```

### Chrome API Not Mocked
```javascript
// Check setup.js is loaded
// Verify jest.config.js has setupFilesAfterEnv
```

---

## CI/CD Integration

### GitHub Actions Example
```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '14'
      - run: npm install
      - run: npm test -- --coverage
      - uses: codecov/codecov-action@v2
```

---

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Testing Library](https://testing-library.com/)
- [Chrome Extension Testing](https://developer.chrome.com/docs/extensions/mv3/testing/)

---

**Last Updated**: November 2025
