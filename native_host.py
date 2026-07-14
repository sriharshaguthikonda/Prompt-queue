
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
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_MEMORY_BASE_URL = "http://127.0.0.1:5599"
DEFAULT_TOKEN_PATH = r"C:\.memory\config\local_token"
DEFAULT_JOBS_FOLDER = r"C:\AI\bridge_jobs\chatgpt_browser"
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
RESULT_FILE_RE = re.compile(r"^result_([A-Za-z0-9_-]+)\.json$")
CLAIMANT_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")
JOB_WATCH_MAX_UNREADABLE_AGE_SECONDS = 300
PROMPT_JOB_RESULT_TEXT_CHARS = 200000
PROMPT_JOB_CLAIM_TTL_SECONDS = 3600
PROMPT_JOB_RESULT_MAX_AGE_SECONDS = 86400
PROMPT_JOB_UNCLAIMED_TTL_SECONDS = 1800
HEARTBEAT_INTERVAL_SECONDS = 15
HEARTBEAT_ALIVE_SECONDS = 45
NATIVE_HOST_LOG_MAX_BYTES = 1_000_000

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
        self.prompt_job_claim_ttl_seconds = PROMPT_JOB_CLAIM_TTL_SECONDS
        self.prompt_job_result_max_age_seconds = PROMPT_JOB_RESULT_MAX_AGE_SECONDS
        self.prompt_job_unclaimed_ttl_seconds = PROMPT_JOB_UNCLAIMED_TTL_SECONDS
        self.job_watch_claimant_id = ""
        self.job_watch_priority = 0
        self.job_watch_busy = False
        self.job_watch_last_heartbeat = 0.0
        self.job_watch_state_lock = threading.Lock()
        self.logger = None
        self.logger_key = None
        
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

        elif msg_type == 'heartbeat':
            return self.update_heartbeat(message)

        elif msg_type == 'log':
            return self.append_extension_log(message)

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
                self.log_info("claim lost job=%s claimant=%s", match.group(1), claimant_id)
                return {"type": "claim_result", "ok": False, "jobFile": job_file}
            except OSError:
                self.log_info("claim lost job=%s claimant=%s", match.group(1), claimant_id)
                return {"type": "claim_result", "ok": False, "jobFile": job_file}
            payload = self.read_job_payload(claimed_path)
            job_id = payload.get("id")
            text = payload.get("text")
        self.log_info("claim ok job=%s claimant=%s", job_id, claimant_id)

        result = {
            "type": "claim_result",
            "ok": True,
            "jobFile": job_file,
            "claimedFile": claimed_file,
            "id": job_id,
            "text": text,
            "wantResult": payload.get("want_result") is True,
        }
        if payload.get("source"):
            result["source"] = payload.get("source")
        if payload.get("conversation_key"):
            result["conversationKey"] = payload.get("conversation_key")
        if payload.get("target_url"):
            result["targetUrl"] = payload.get("target_url")
        if payload.get("new_chat") is True:
            result["newChat"] = True
        return result

    def finish_job(self, message):
        folder = message.get("folder", "")
        claimed_file = message.get("claimedFile", "")
        status = message.get("status", "")
        match = CLAIMED_JOB_FILE_RE.fullmatch(claimed_file)
        if not match or status not in {"done", "error"}:
            return {"type": "finish_result", "ok": False}

        claimed_path = Path(folder) / claimed_file
        try:
            payload = self.read_job_payload(claimed_path)
            want_result = payload.get("want_result") is True
            if status == "done":
                if want_result:
                    self.write_result_file(
                        Path(folder),
                        match.group(1),
                        status,
                        message.get("responseText", ""),
                        None,
                        conversation_url=message.get("conversationUrl", ""),
                    )
                claimed_path.unlink()
            else:
                if want_result:
                    self.write_result_file(
                        Path(folder),
                        match.group(1),
                        status,
                        "",
                        message.get("error") or status,
                        conversation_url=message.get("conversationUrl", ""),
                    )
                    claimed_path.unlink()
                else:
                    error_path = Path(folder) / f"job_{match.group(1)}.error.json"
                    os.replace(claimed_path, error_path)
            self.log_info("finish job=%s status=%s", match.group(1), status)
            return {"type": "finish_result", "ok": True}
        except OSError:
            return {"type": "finish_result", "ok": False}

    def watch_jobs(self, message):
        folder = message.get("folder") or DEFAULT_JOBS_FOLDER
        poll_ms = message.get("pollMs", 1000)
        raw_claimant_id = message.get("claimant_id")
        if raw_claimant_id is None:
            raw_claimant_id = message.get("claimantId")
        claimant_id = self.sanitize_claimant_id(raw_claimant_id) if raw_claimant_id else ""
        priority = self.coerce_priority(message.get("priority"))
        self.prompt_job_claim_ttl_seconds = self.coerce_seconds(
            message.get("claimTtlSeconds"),
            PROMPT_JOB_CLAIM_TTL_SECONDS,
        )
        self.prompt_job_result_max_age_seconds = self.coerce_seconds(
            message.get("resultMaxAgeSeconds"),
            PROMPT_JOB_RESULT_MAX_AGE_SECONDS,
        )
        self.prompt_job_unclaimed_ttl_seconds = self.coerce_seconds(
            message.get("unclaimedTtlSeconds"),
            PROMPT_JOB_UNCLAIMED_TTL_SECONDS,
        )
        try:
            poll_seconds = max(float(poll_ms) / 1000.0, 0.001)
        except (TypeError, ValueError):
            poll_seconds = 1.0

        Path(folder).mkdir(parents=True, exist_ok=True)
        self.configure_logger(Path(folder), claimant_id)
        with self.job_watch_state_lock:
            self.job_watch_claimant_id = claimant_id
            self.job_watch_priority = priority
            self.job_watch_busy = bool(message.get("busy", False))
            self.job_watch_last_heartbeat = 0.0

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
        self.log_info("watch start folder=%s claimant=%s priority=%s", folder, claimant_id or "none", priority)
        return {"type": "watch_started", "folder": folder}

    def stop_job_watcher(self):
        if self.job_watch_stop:
            self.job_watch_stop.set()
        if self.job_watch_thread and self.job_watch_thread.is_alive():
            self.job_watch_thread.join(timeout=1.0)
        if self.job_watch_folder:
            self.log_info("watch stop folder=%s", self.job_watch_folder)
        self.job_watch_thread = None
        self.job_watch_stop = None

    def job_watch_loop(self, folder, poll_seconds, stop_event):
        while not stop_event.is_set():
            current_files = set()
            try:
                folder_path = Path(folder)
                self.maybe_write_heartbeat(folder_path, force=False)
                self.write_expired_claim_results(folder_path)
                self.cleanup_stale_result_files(folder_path)
                for path in folder_path.glob("job_*.json"):
                    name = path.name
                    if ".claimed." in name or ".error." in name:
                        continue
                    if not JOB_FILE_RE.fullmatch(name):
                        continue
                    current_files.add(name)
                    try:
                        age_seconds = time.time() - path.stat().st_mtime
                    except OSError:
                        continue
                    if age_seconds > self.prompt_job_unclaimed_ttl_seconds:
                        if self.write_unclaimed_job_expired_result(folder_path, path):
                            continue
                    payload = self.read_job_payload(path)
                    want_result = payload.get("want_result") is True
                    if not want_result and name in self.job_watch_announced:
                        continue
                    if (
                        not want_result
                        and age_seconds > JOB_WATCH_MAX_UNREADABLE_AGE_SECONDS
                    ):
                        continue
                    job_id = payload.get("id")
                    text = payload.get("text")
                    if not self.is_usable_job_payload(job_id, text):
                        continue
                    self.job_watch_announced.add(name)
                    message = {
                        "type": "job_found",
                        "jobFile": name,
                        "id": job_id,
                        "text": text,
                        "wantResult": want_result,
                        "instances": self.read_alive_heartbeats(folder_path),
                    }
                    if payload.get("source"):
                        message["source"] = payload.get("source")
                    if payload.get("conversation_key"):
                        message["conversationKey"] = payload.get("conversation_key")
                    self.send_message(message)
                    self.log_info("announce job=%s want_result=%s instances=%s", job_id, want_result, len(message["instances"]))
                self.job_watch_announced.intersection_update(current_files)
            except OSError as e:
                self.log_exception("watch loop os error: %s", e)
                self.job_watch_announced = set()
            except Exception as e:
                self.log_exception("watch loop unhandled exception: %s", e)
            stop_event.wait(poll_seconds)

    def read_job_payload(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            source = data.get("source")
            conversation_key = data.get("conversation_key")
            target_url = data.get("target_url")
            new_chat = data.get("new_chat")
            attempts = data.get("attempts", 0)
            return {
                "id": data.get("id"),
                "text": data.get("text"),
                "want_result": data.get("want_result") is True,
                "source": source if isinstance(source, str) else "",
                "conversation_key": conversation_key.strip() if isinstance(conversation_key, str) else "",
                "target_url": target_url.strip() if isinstance(target_url, str) else "",
                "new_chat": new_chat is True,
                "attempts": attempts if isinstance(attempts, int) and attempts >= 0 else 0,
            }
        except (OSError, json.JSONDecodeError, TypeError):
            return {
                "id": None,
                "text": None,
                "want_result": False,
                "source": "",
                "conversation_key": "",
                "target_url": "",
                "new_chat": False,
                "attempts": 0,
            }

    def read_raw_job_payload(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError, TypeError):
            return {}

    def write_result_file(
        self,
        folder,
        job_id,
        status,
        text,
        error=None,
        reason=None,
        claimed_by=None,
        attempts=None,
        conversation_url="",
    ):
        response_text = text if isinstance(text, str) else ""
        text_chars = len(response_text)
        truncated = text_chars > PROMPT_JOB_RESULT_TEXT_CHARS
        if truncated:
            response_text = response_text[:PROMPT_JOB_RESULT_TEXT_CHARS]
        payload = {
            "id": job_id,
            "status": status,
            "text": response_text,
            "error": None if status == "done" else str(error or status),
            "truncated": truncated,
            "text_chars": text_chars,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        if reason:
            payload["reason"] = reason
        if claimed_by:
            payload["claimed_by"] = claimed_by
        if attempts is not None:
            payload["attempts"] = attempts
        if isinstance(conversation_url, str) and conversation_url:
            payload["conversation_url"] = conversation_url
        result_path = folder / f"result_{job_id}.json"
        tmp_path = folder / f".result_{job_id}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp_path, result_path)
        finally:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass

    def write_unclaimed_job_expired_result(self, folder, path):
        match = JOB_FILE_RE.fullmatch(path.name)
        if not match:
            return False
        payload = self.read_job_payload(path)
        if payload.get("want_result") is not True:
            return False
        result_path = folder / f"result_{match.group(1)}.json"
        if not result_path.exists():
            self.write_result_file(
                folder,
                match.group(1),
                "error",
                "",
                "job_unclaimed_expired",
                reason="job_unclaimed_expired",
            )
        try:
            path.unlink()
        except OSError:
            pass
        self.job_watch_announced.discard(path.name)
        return True

    def write_expired_claim_results(self, folder):
        now = time.time()
        swept = 0
        for path in folder.glob("job_*.claimed.*.json"):
            match = CLAIMED_JOB_FILE_RE.fullmatch(path.name)
            if not match:
                continue
            result_path = folder / f"result_{match.group(1)}.json"
            try:
                if now - path.stat().st_mtime <= self.prompt_job_claim_ttl_seconds:
                    continue
            except OSError:
                continue
            payload = self.read_job_payload(path)
            if payload.get("want_result") is not True:
                try:
                    path.unlink()
                    swept += 1
                    self.log_info("sweep delete voice claim job=%s claimant=%s", match.group(1), match.group(2))
                except OSError:
                    pass
                continue
            attempts = payload.get("attempts", 0) + 1
            if attempts >= 2:
                if not result_path.exists():
                    self.write_result_file(
                        folder,
                        match.group(1),
                        "error",
                        "",
                        "claim_expired",
                        reason="claim_expired",
                        claimed_by=match.group(2),
                        attempts=attempts,
                    )
                    self.log_info("sweep claim expired job=%s claimant=%s attempts=%s", match.group(1), match.group(2), attempts)
                try:
                    path.unlink()
                    swept += 1
                except OSError:
                    pass
                continue
            raw_payload = self.read_raw_job_payload(path)
            if raw_payload:
                raw_payload["attempts"] = attempts
                job_path = folder / f"job_{match.group(1)}.json"
                self.write_json_atomic(job_path, raw_payload)
                self.log_info("requeue job=%s claimant=%s attempts=%s", match.group(1), match.group(2), attempts)
            else:
                self.write_result_file(
                    folder,
                    match.group(1),
                    "error",
                    "",
                    "claim_expired",
                    reason="claim_expired",
                    claimed_by=match.group(2),
                    attempts=attempts,
                )
            try:
                path.unlink()
                swept += 1
            except OSError:
                pass
        if swept:
            self.log_info("ttl sweep expired_claims=%s", swept)

    def cleanup_stale_result_files(self, folder):
        now = time.time()
        for path in folder.glob("result_*.json"):
            if not RESULT_FILE_RE.fullmatch(path.name):
                continue
            try:
                if now - path.stat().st_mtime > self.prompt_job_result_max_age_seconds:
                    path.unlink()
            except OSError:
                pass

    def coerce_seconds(self, value, fallback):
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            return fallback
        if seconds <= 0:
            return fallback
        return seconds

    def coerce_priority(self, value):
        try:
            priority = int(value)
        except (TypeError, ValueError):
            return 0
        return max(0, min(priority, 10))

    def is_usable_job_payload(self, job_id, text):
        return (
            isinstance(job_id, str)
            and bool(job_id.strip())
            and isinstance(text, str)
            and bool(text.strip())
        )

    def sanitize_claimant_id(self, claimant_id):
        sanitized = CLAIMANT_SAFE_RE.sub("", str(claimant_id or ""))
        return sanitized or "claimant"

    def write_json_atomic(self, path, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.parent / f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp_path, path)
        finally:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass

    def maybe_write_heartbeat(self, folder, force=False):
        with self.job_watch_state_lock:
            claimant_id = self.job_watch_claimant_id
            priority = self.job_watch_priority
            busy = self.job_watch_busy
            last_heartbeat = self.job_watch_last_heartbeat
        if not claimant_id:
            return
        now = time.monotonic()
        if not force and last_heartbeat and now - last_heartbeat < HEARTBEAT_INTERVAL_SECONDS:
            return
        payload = {
            "claimant_id": claimant_id,
            "priority": priority,
            "busy": busy,
            "ts": time.time(),
        }
        self.write_json_atomic(folder / "heartbeats" / f"{claimant_id}.json", payload)
        with self.job_watch_state_lock:
            self.job_watch_last_heartbeat = now

    def read_alive_heartbeats(self, folder):
        instances = []
        now = time.time()
        heartbeat_dir = folder / "heartbeats"
        try:
            paths = list(heartbeat_dir.glob("*.json"))
        except OSError:
            return instances
        for path in paths:
            try:
                stat = path.stat()
                age_seconds = now - stat.st_mtime
                if age_seconds >= HEARTBEAT_ALIVE_SECONDS:
                    continue
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, json.JSONDecodeError, TypeError):
                continue
            claimant_id = data.get("claimant_id")
            if not isinstance(claimant_id, str) or not claimant_id:
                continue
            instances.append({
                "claimant_id": claimant_id,
                "priority": self.coerce_priority(data.get("priority")),
                "busy": data.get("busy") is True,
                "age_seconds": age_seconds,
            })
        instances.sort(key=lambda item: item["claimant_id"])
        return instances

    def update_heartbeat(self, message):
        with self.job_watch_state_lock:
            self.job_watch_busy = message.get("busy") is True
            folder = self.job_watch_folder
        if folder:
            try:
                self.maybe_write_heartbeat(Path(folder), force=True)
            except OSError as e:
                self.log_exception("heartbeat write failed: %s", e)
                return {"type": "heartbeat_result", "ok": False}
        return {"type": "heartbeat_result", "ok": True}

    def configure_logger(self, folder, claimant_id):
        log_id = claimant_id or str(os.getpid())
        key = (str(folder), log_id)
        if self.logger and self.logger_key == key:
            return
        logger = logging.getLogger(f"native_host.{os.getpid()}.{log_id}")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()
        log_path = folder / "logs" / f"native_host_{log_id}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            log_path,
            maxBytes=NATIVE_HOST_LOG_MAX_BYTES,
            backupCount=1,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
        self.logger = logger
        self.logger_key = key

    def log_info(self, message, *args):
        if self.logger:
            self.logger.info(message, *args)

    def log_exception(self, message, *args):
        if self.logger:
            self.logger.exception(message, *args)

    def append_extension_log(self, message):
        line = message.get("line", "")
        if not isinstance(line, str):
            line = str(line)
        self.log_info("EXT %s", line[:2000])
        return {"type": "log_result", "ok": True}
            
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
