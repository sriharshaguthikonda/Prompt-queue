// Offscreen script for file system access

// Console prefix patch
(function () {
  if (console.__aiPromptQueuePatched) return;
  const PREFIX = '[AI Prompt Queue - Offscreen]';
  console.__aiPromptQueuePatched = true;
  ['log', 'info', 'warn', 'error', 'debug'].forEach((method) => {
    const original = console[method]?.bind(console);
    if (original) {
      console[method] = (...args) => {
        const first = args[0];
        if (typeof first === 'string') {
          original(`${PREFIX} ${first}`, ...args.slice(1));
        } else {
          original(PREFIX, ...args);
        }
      };
    }
  });
})();

// Handle messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_TRANSCRIPTION_FILES') {
    checkFiles(message.folder, message.processedFiles)
      .then(newFiles => sendResponse({ newFiles }))
      .catch(error => {
        console.error('Error checking files:', error);
        sendResponse({ newFiles: [] });
      });
    return true; // Keep message channel open for async response
  } else if (message.type === 'READ_TRANSCRIPTION_FILE') {
    readFileContent(message.filePath)
      .then(content => sendResponse({ content }))
      .catch(error => {
        console.error('Error reading file:', error);
        sendResponse({ content: null });
      });
    return true; // Keep message channel open for async response
  }
});

// Check for new JSON files in the specified folder
async function checkFiles(folder, processedFiles) {
  try {
    // For Chrome extensions, we need to use the File System Access API
    // However, this requires user interaction. As a workaround, we'll use
    // a different approach - monitoring through directory picker
    
    // Since Chrome extensions have limited file system access,
    // we'll implement a polling mechanism that works with user-selected folders
    
    console.log('Checking folder:', folder);
    console.log('Already processed:', processedFiles);
    
    // This is a placeholder - in a real implementation, you'd need
    // to use the File System Access API with proper user permissions
    // For now, we'll return empty array and implement a different approach
    
    return [];
  } catch (error) {
    console.error('Error checking files:', error);
    return [];
  }
}

// Read file content
async function readFileContent(filePath) {
  try {
    // Again, this is limited by Chrome extension security
    // We'll need to implement a different approach
    
    console.log('Reading file:', filePath);
    return null;
  } catch (error) {
    console.error('Error reading file:', error);
    return null;
  }
}

// Alternative approach: Use a native messaging host
// This would require a separate native application that the extension can communicate with

console.log('Offscreen script loaded');
