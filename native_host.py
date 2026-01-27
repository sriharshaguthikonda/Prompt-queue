#!/usr/bin/env python3
"""
Native messaging host for AI Prompt Queue Chrome Extension
Handles file system monitoring for transcription files
"""

import sys
import json
import struct
import os
import time
import glob
from pathlib import Path

class TranscriptionMonitor:
    def __init__(self):
        self.processed_files = set()
        self.watch_folder = ""
        self.running = True
        
    def send_message(self, message):
        """Send message to Chrome extension"""
        encoded_message = json.dumps(message).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('@I', len(encoded_message)))
        sys.stdout.buffer.write(encoded_message)
        sys.stdout.buffer.flush()
        
    def read_message(self):
        """Read message from Chrome extension"""
        text_length_bytes = sys.stdin.buffer.read(4)
        if len(text_length_bytes) == 0:
            return None
            
        text_length = struct.unpack('@I', text_length_bytes)[0]
        message = sys.stdin.buffer.read(text_length).decode('utf-8')
        return json.loads(message)
        
    def check_for_new_files(self, folder, processed_files):
        """Check for new JSON files in the specified folder"""
        try:
            if not os.path.exists(folder):
                return {"type": "error", "message": f"Folder does not exist: {folder}"}
                
            # Look for JSON files
            json_files = glob.glob(os.path.join(folder, "*.json"))
            new_files = []
            
            for file_path in json_files:
                if file_path not in processed_files:
                    # Check if it's a transcription file by looking for groq_response
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                            if 'groq_response' in data or 'text' in data:
                                new_files.append(file_path)
                    except:
                        continue
                        
            return {"type": "files_found", "new_files": new_files}
            
        except Exception as e:
            return {"type": "error", "message": str(e)}
            
    def read_file_content(self, file_path):
        """Read content of a specific file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            return {"type": "file_content", "content": content}
        except Exception as e:
            return {"type": "error", "message": str(e)}
            
    def handle_message(self, message):
        """Handle incoming message from Chrome extension"""
        msg_type = message.get('type')
        
        if msg_type == 'check_files':
            folder = message.get('folder', '')
            processed_files = set(message.get('processed_files', []))
            return self.check_for_new_files(folder, processed_files)
            
        elif msg_type == 'read_file':
            file_path = message.get('filePath', '')
            return self.read_file_content(file_path)
            
        elif msg_type == 'start_monitoring':
            self.watch_folder = message.get('folder', '')
            return {"type": "monitoring_started", "folder": self.watch_folder}
            
        elif msg_type == 'stop_monitoring':
            self.watch_folder = ""
            return {"type": "monitoring_stopped"}
            
        else:
            return {"type": "error", "message": f"Unknown message type: {msg_type}"}
            
    def run(self):
        """Main message loop"""
        try:
            while self.running:
                message = self.read_message()
                if message is None:
                    break
                    
                response = self.handle_message(message)
                self.send_message(response)
                
        except KeyboardInterrupt:
            pass
        except Exception as e:
            self.send_message({"type": "error", "message": f"Host error: {str(e)}"})

if __name__ == '__main__':
    monitor = TranscriptionMonitor()
    monitor.run()
