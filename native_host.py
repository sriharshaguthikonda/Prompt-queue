
"""
Native messaging host for AI Prompt Queue Chrome Extension
Handles file system monitoring for transcription files
"""

import sys
import json
import struct
import os
import re
import threading
import time
import glob
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_MEMORY_BASE_URL = "http://127.0.0.1:5599"
DEFAULT_TOKEN_PATH = r"C:\.memory\config\local_token"
MEMORY_TIMEOUT_SECONDS = 10
ALLOWED_MEMORY_TYPES = {
    "memory_healthz",
    "memory_pack_browser",
    "memory_projects",
    "memory_get",
}
JOB_FILE_RE = re.compile(r"^job_([A-Za-z0-9_-]+)\.json$")
CLAIMED_JOB_FILE_RE = re.compile(
    r"^job_([A-Za-z0-9_-]+)\.claimed\.([A-Za-z0-9_-]+)\.json$"
)
CLAIMANT_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")

class TranscriptionMonitor:
    def __init__(self, memory_base_url=DEFAULT_MEMORY_BASE_URL, http_open=None):
        self.processed_files = set()
        self.watch_folder = ""
        self.running = True
        self.memory_base_url = memory_base_url.rstrip("/")
        self.http_open = http_open or urlopen
        self.send_lock = threading.Lock()
        self.job_claim_lock = threading.Lock()
        self.job_watch_thread = None
        self.job_watch_stop = None
        self.job_watch_folder = ""
        self.job_watch_announced = set()
        
    def send_message(self, message):
        """Send message to Chrome extension"""
        encoded_message = json.dumps(message).encode('utf-8')
        with self.send_lock:
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
            
            # Convert processed_files to set for faster lookup
            processed_set = set(processed_files)
            
            for file_path in json_files:
                # Only return files that haven't been processed
                if file_path not in processed_set:
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
            
        elif msg_type == 'read_state_file':
            state_file = message.get('stateFile', '')
            return self.read_state_file(state_file)
            
        elif msg_type == 'save_state_file':
            state_file = message.get('stateFile', '')
            content = message.get('content', '')
            return self.save_state_file(state_file, content)
            
        elif msg_type == 'start_monitoring':
            self.watch_folder = message.get('folder', '')
            return {"type": "monitoring_started", "folder": self.watch_folder}
            
        elif msg_type == 'stop_monitoring':
            self.watch_folder = ""
            return {"type": "monitoring_stopped"}

        elif msg_type == 'claim_job':
            return self.claim_job(message)

        elif msg_type == 'finish_job':
            return self.finish_job(message)

        elif msg_type == 'watch_jobs':
            return self.watch_jobs(message)

        elif msg_type in ALLOWED_MEMORY_TYPES:
            return self.handle_memory_message(message)

        elif isinstance(msg_type, str) and msg_type.startswith("memory_"):
            return {
                "type": "error",
                "ok": False,
                "code": "UNSUPPORTED_MEMORY_OPERATION",
                "message": "Unsupported memory operation",
            }
            
        else:
            return {"type": "error", "message": f"Unknown message type: {msg_type}"}

    def get_memory_token(self, message):
        """Read the local memory token at request time."""
        token_path = message.get("token_path") or DEFAULT_TOKEN_PATH
        with open(token_path, "r", encoding="utf-8") as f:
            return f.read().strip()

    def handle_memory_message(self, message):
        """Proxy allowlisted read-only memory bridge operations."""
        try:
            msg_type = message.get("type")
            token = self.get_memory_token(message)

            if msg_type == "memory_healthz":
                return self.proxy_memory_request(msg_type, "GET", "/healthz", token)

            if msg_type == "memory_pack_browser":
                payload = {
                    key: value for key, value in message.items()
                    if key not in {"type", "token_path"}
                }
                return self.proxy_memory_request(
                    msg_type,
                    "POST",
                    "/pack/browser",
                    token,
                    payload=payload,
                )

            if msg_type == "memory_projects":
                return self.proxy_memory_request(msg_type, "GET", "/memory/projects", token)

            if msg_type == "memory_get":
                memory_id = str(message.get("memory_id") or message.get("id") or "").strip()
                if not memory_id:
                    return {
                        "type": "error",
                        "ok": False,
                        "code": "MISSING_MEMORY_ID",
                        "message": "memory_id is required",
                    }
                return self.proxy_memory_request(
                    msg_type,
                    "GET",
                    f"/memory/{quote(memory_id, safe='')}",
                    token,
                )

            return {
                "type": "error",
                "ok": False,
                "code": "UNSUPPORTED_MEMORY_OPERATION",
                "message": "Unsupported memory operation",
            }
        except OSError:
            return {
                "type": "error",
                "ok": False,
                "code": "TOKEN_UNAVAILABLE",
                "message": "Memory token unavailable",
            }

    def proxy_memory_request(self, msg_type, method, path, token, payload=None):
        body = None
        headers = {"X-Memory-Token": token}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = Request(
            f"{self.memory_base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )

        try:
            with self.http_open(request, timeout=MEMORY_TIMEOUT_SECONDS) as response:
                response_body = response.read()
                parsed_body = self.parse_memory_response(response_body, response.headers)
                return {
                    "type": f"{msg_type}_result",
                    "ok": True,
                    "status": getattr(response, "status", 200),
                    "content_type": response.headers.get("Content-Type", ""),
                    "body": parsed_body,
                }
        except HTTPError as e:
            return {
                "type": "error",
                "ok": False,
                "status": e.code,
                "code": "MEMORY_BRIDGE_HTTP_ERROR",
                "message": "Memory bridge request failed",
            }
        except URLError:
            return {
                "type": "error",
                "ok": False,
                "code": "MEMORY_BRIDGE_UNAVAILABLE",
                "message": "Memory bridge unavailable",
            }

    def parse_memory_response(self, response_body, headers):
        content_type = headers.get("Content-Type", "")
        text = response_body.decode("utf-8")
        if "application/json" in content_type:
            return json.loads(text) if text else {}
        return text

    def claim_job(self, message):
        folder = message.get("folder", "")
        job_file = message.get("jobFile", "")
        match = JOB_FILE_RE.fullmatch(job_file)
        if not match:
            return {"type": "claim_result", "ok": False, "jobFile": job_file}

        claimant_id = self.sanitize_claimant_id(message.get("claimantId", ""))
        claimed_file = f"job_{match.group(1)}.claimed.{claimant_id}.json"
        source_path = Path(folder) / job_file
        claimed_path = Path(folder) / claimed_file

        with self.job_claim_lock:
            try:
                os.rename(source_path, claimed_path)
            except (FileNotFoundError, PermissionError):
                return {"type": "claim_result", "ok": False, "jobFile": job_file}
            except OSError:
                return {"type": "claim_result", "ok": False, "jobFile": job_file}
            job_id, text = self.read_job_payload(claimed_path)

        return {
            "type": "claim_result",
            "ok": True,
            "jobFile": job_file,
            "claimedFile": claimed_file,
            "id": job_id,
            "text": text,
        }

    def finish_job(self, message):
        folder = message.get("folder", "")
        claimed_file = message.get("claimedFile", "")
        status = message.get("status", "")
        match = CLAIMED_JOB_FILE_RE.fullmatch(claimed_file)
        if not match or status not in {"done", "error"}:
            return {"type": "finish_result", "ok": False}

        claimed_path = Path(folder) / claimed_file
        try:
            if status == "done":
                claimed_path.unlink()
            else:
                error_path = Path(folder) / f"job_{match.group(1)}.error.json"
                os.replace(claimed_path, error_path)
            return {"type": "finish_result", "ok": True}
        except OSError:
            return {"type": "finish_result", "ok": False}

    def watch_jobs(self, message):
        folder = message.get("folder", "")
        poll_ms = message.get("pollMs", 1000)
        try:
            poll_seconds = max(float(poll_ms) / 1000.0, 0.001)
        except (TypeError, ValueError):
            poll_seconds = 1.0

        if folder != self.job_watch_folder:
            self.stop_job_watcher()
            self.job_watch_announced = set()
        elif self.job_watch_thread and self.job_watch_thread.is_alive():
            return {"type": "watch_started", "folder": folder}

        self.job_watch_folder = folder
        self.job_watch_stop = threading.Event()
        self.job_watch_thread = threading.Thread(
            target=self.job_watch_loop,
            args=(folder, poll_seconds, self.job_watch_stop),
            daemon=True,
        )
        self.job_watch_thread.start()
        return {"type": "watch_started", "folder": folder}

    def stop_job_watcher(self):
        if self.job_watch_stop:
            self.job_watch_stop.set()
        if self.job_watch_thread and self.job_watch_thread.is_alive():
            self.job_watch_thread.join(timeout=1.0)
        self.job_watch_thread = None
        self.job_watch_stop = None

    def job_watch_loop(self, folder, poll_seconds, stop_event):
        while not stop_event.is_set():
            current_files = set()
            try:
                for path in Path(folder).glob("job_*.json"):
                    name = path.name
                    if ".claimed." in name or ".error." in name:
                        continue
                    if not JOB_FILE_RE.fullmatch(name):
                        continue
                    current_files.add(name)
                    if name in self.job_watch_announced:
                        continue
                    job_id, text = self.read_job_payload(path)
                    self.job_watch_announced.add(name)
                    self.send_message({
                        "type": "job_found",
                        "jobFile": name,
                        "id": job_id,
                        "text": text,
                    })
                self.job_watch_announced.intersection_update(current_files)
            except OSError:
                self.job_watch_announced = set()
            stop_event.wait(poll_seconds)

    def read_job_payload(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("id"), data.get("text")
        except (OSError, json.JSONDecodeError, TypeError):
            return None, None

    def sanitize_claimant_id(self, claimant_id):
        sanitized = CLAIMANT_SAFE_RE.sub("", str(claimant_id or ""))
        return sanitized or "claimant"
            
    def read_state_file(self, state_file):
        """Read the state file content"""
        try:
            # Get the directory where the script is located
            script_dir = os.path.dirname(os.path.abspath(__file__))
            state_path = os.path.join(script_dir, state_file)
            
            if os.path.exists(state_path):
                with open(state_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                return {"type": "file_content", "content": content}
            else:
                # Return empty state if file doesn't exist
                empty_state = {
                    "isEnabled": False,
                    "watchFolder": "",
                    "processedFiles": [],
                    "lastCheckTime": 0,
                    "automationStarted": False
                }
                return {"type": "file_content", "content": json.dumps(empty_state)}
        except Exception as e:
            return {"type": "error", "message": str(e)}
            
    def save_state_file(self, state_file, content):
        """Save content to the state file"""
        try:
            # Get the directory where the script is located
            script_dir = os.path.dirname(os.path.abspath(__file__))
            state_path = os.path.join(script_dir, state_file)
            
            with open(state_path, 'w', encoding='utf-8') as f:
                f.write(content)
            return {"type": "success", "message": "State saved successfully"}
        except Exception as e:
            return {"type": "error", "message": str(e)}
            
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
