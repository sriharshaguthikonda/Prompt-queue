# Transcription Monitor Setup Guide

This feature allows the AI Prompt Queue extension to automatically monitor a folder for new transcription JSON files and add them to your prompt queue.

## Features

- **Automatic Monitoring**: Watches a specified folder for new JSON transcription files
- **Smart Detection**: Only processes files that contain transcription data (Groq response format)
- **State Tracking**: Remembers which files have been processed to avoid duplicates
- **Real-time Updates**: Automatically adds new transcriptions to your prompt queue
- **Notifications**: Shows desktop notifications when new transcriptions are detected

## Setup Instructions

### 1. Install Python Native Host

The extension uses a Python native messaging host to access the file system.

1. **Install Python** (if not already installed):
   - Download from https://python.org
   - Make sure Python is added to PATH

2. **Run the installation script**:
   ```batch
   cd "c:\Windows_software\Chrome_extensions\Prompt-queue"
   install_native_host.bat
   ```

3. **Update Extension ID**:
   - Open Chrome and go to `chrome://extensions`
   - Find "AI Prompt Queue" and copy its ID
   - Edit `native_host.json` and replace `YOUR_EXTENSION_ID` with the actual ID

### 2. Enable the Extension

1. **Load/Reload the Extension**:
   - Go to `chrome://extensions`
   - Click "Reload" for the AI Prompt Queue extension

2. **Grant Permissions**:
   - The extension will request the necessary permissions automatically

### 3. Configure Monitoring

1. **Open the Extension**:
   - Click the extension icon in Chrome
   - The side panel will open

2. **Set Up Transcription Monitor**:
   - Expand the "Transcription Monitor" section
   - Enter your transcription folder path (e.g., `I:\Transcriptions`)
   - Click "Start Monitoring"

3. **Test the Setup**:
   - Create a new JSON file in your transcription folder
   - The extension should detect it and add the transcript to your prompt queue

## Usage

### Starting Monitoring

1. Enter the folder path containing your transcription files
2. Click "▶️ Start Monitoring"
3. The status will change to "Monitoring" with a green indicator

### Stopping Monitoring

1. Click "⏹️ Stop Monitoring"
2. The status will change to "Not Monitoring"

### How It Works

- The extension checks the folder every 5 seconds for new JSON files
- It only processes files that contain transcription data (looks for `groq_response.text` or `text` fields)
- Each processed file is marked to avoid reprocessing
- New transcriptions are added to your prompt queue with the format: `Transcript from filename.json: [transcript text]`

## File Format Support

The extension supports JSON files with the following structure:

```json
{
  "groq_response": {
    "text": "Your transcription text here..."
  }
}
```

Or simple format:

```json
{
  "text": "Your transcription text here..."
}
```

## Troubleshooting

### "Native host not available" Error

1. Make sure you ran the `install_native_host.bat` script
2. Check that Python is installed and in your PATH
3. Verify the extension ID in `native_host.json` is correct
4. Restart Chrome after making changes

### No Files Being Detected

1. Verify the folder path is correct (use forward slashes or escaped backslashes)
2. Make sure JSON files contain transcription data
3. Check that files aren't already in the processed list
4. Try stopping and restarting monitoring

### Extension Not Working

1. Check Chrome's developer console for errors
2. Make sure all files are in the correct directory
3. Reload the extension after making changes

## Technical Details

- **Native Host**: Python script that handles file system operations
- **Communication**: Chrome Native Messaging API
- **Storage**: Extension stores processed file list in local storage
- **Monitoring**: Polls every 5 seconds for new files
- **Security**: Only accesses the specified folder and JSON files

## Files Created

- `native_host.py` - Python native messaging host
- `native_host.json` - Native host configuration (auto-generated)
- `install_native_host.bat` - Installation script
- Registry entries for native messaging (auto-created)

## Security Notes

- The native host only accesses the folder you specify
- It only reads JSON files, not other file types
- All communication is local to your computer
- No data is sent to external servers
