import inspect
import json
import os
import threading
import time

import native_host


def write_job(path, job_id="abc", text="hello", want_result=False, source=None):
    payload = {"id": job_id, "text": text, "ts": 123}
    if want_result:
        payload["want_result"] = True
    if source:
        payload["source"] = source
    path.write_text(
        json.dumps(payload),
        encoding="utf-8",
    )


def test_claim_job_allows_exactly_one_concurrent_claimant(tmp_path):
    job_file = tmp_path / "job_abc.json"
    write_job(job_file, job_id="abc", text="claim me")
    monitor = native_host.TranscriptionMonitor()
    responses = []
    lock = threading.Lock()

    def claim(index):
        response = monitor.handle_message({
            "type": "claim_job",
            "folder": str(tmp_path),
            "jobFile": "job_abc.json",
            "claimantId": f"worker_{index}",
        })
        with lock:
            responses.append(response)

    threads = [threading.Thread(target=claim, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    winners = [response for response in responses if response["ok"]]
    losers = [response for response in responses if not response["ok"]]
    claimed_files = list(tmp_path.glob("job_abc.claimed.*.json"))

    assert len(winners) == 1
    assert len(losers) == 3
    assert len(claimed_files) == 1
    assert winners[0]["type"] == "claim_result"
    assert winners[0]["jobFile"] == "job_abc.json"
    assert winners[0]["claimedFile"] == claimed_files[0].name
    assert winners[0]["id"] == "abc"
    assert winners[0]["text"] == "claim me"


def test_finish_job_done_deletes_and_error_renames(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    done_file = tmp_path / "job_done.claimed.worker_1.json"
    error_file = tmp_path / "job_error.claimed.worker_2.json"
    write_job(done_file, job_id="done", text="done text")
    write_job(error_file, job_id="error", text="error text")

    done_response = monitor.handle_message({
        "type": "finish_job",
        "folder": str(tmp_path),
        "claimedFile": done_file.name,
        "status": "done",
    })
    error_response = monitor.handle_message({
        "type": "finish_job",
        "folder": str(tmp_path),
        "claimedFile": error_file.name,
        "status": "error",
    })

    assert done_response == {"type": "finish_result", "ok": True}
    assert error_response == {"type": "finish_result", "ok": True}
    assert not done_file.exists()
    assert not error_file.exists()
    assert (tmp_path / "job_error.error.json").exists()


def test_finish_job_want_result_done_writes_result_and_removes_claim(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    claimed_file = tmp_path / "job_bridge.claimed.worker_1.json"
    write_job(claimed_file, job_id="bridge", text="prompt text", want_result=True)

    response = monitor.handle_message({
        "type": "finish_job",
        "folder": str(tmp_path),
        "claimedFile": claimed_file.name,
        "status": "done",
        "responseText": "assistant answer",
    })

    result_file = tmp_path / "result_bridge.json"
    assert response == {"type": "finish_result", "ok": True}
    assert not claimed_file.exists()
    result = json.loads(result_file.read_text(encoding="utf-8"))
    assert result["id"] == "bridge"
    assert result["status"] == "done"
    assert result["text"] == "assistant answer"
    assert result["error"] is None
    assert result["truncated"] is False
    assert result["text_chars"] == len("assistant answer")
    assert "ts" in result


def test_finish_job_want_result_error_writes_error_result(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    claimed_file = tmp_path / "job_bridge_err.claimed.worker_1.json"
    write_job(claimed_file, job_id="bridge_err", text="prompt text", want_result=True)

    response = monitor.handle_message({
        "type": "finish_job",
        "folder": str(tmp_path),
        "claimedFile": claimed_file.name,
        "status": "error",
        "error": "missing_response",
    })

    result = json.loads((tmp_path / "result_bridge_err.json").read_text(encoding="utf-8"))
    assert response == {"type": "finish_result", "ok": True}
    assert not claimed_file.exists()
    assert not (tmp_path / "job_bridge_err.error.json").exists()
    assert result["id"] == "bridge_err"
    assert result["status"] == "error"
    assert result["text"] == ""
    assert result["error"] == "missing_response"
    assert result["truncated"] is False
    assert result["text_chars"] == 0


def test_finish_job_voice_job_writes_no_result(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    claimed_file = tmp_path / "job_voice.claimed.worker_1.json"
    write_job(claimed_file, job_id="voice", text="voice prompt")

    response = monitor.handle_message({
        "type": "finish_job",
        "folder": str(tmp_path),
        "claimedFile": claimed_file.name,
        "status": "done",
        "responseText": "ignored",
    })

    assert response == {"type": "finish_result", "ok": True}
    assert not claimed_file.exists()
    assert not (tmp_path / "result_voice.json").exists()


def test_finish_job_want_result_truncates_text(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    claimed_file = tmp_path / "job_long.claimed.worker_1.json"
    write_job(claimed_file, job_id="long", text="prompt text", want_result=True)
    response_text = "x" * (native_host.PROMPT_JOB_RESULT_TEXT_CHARS + 5)

    response = monitor.handle_message({
        "type": "finish_job",
        "folder": str(tmp_path),
        "claimedFile": claimed_file.name,
        "status": "done",
        "responseText": response_text,
    })

    result = json.loads((tmp_path / "result_long.json").read_text(encoding="utf-8"))
    assert response == {"type": "finish_result", "ok": True}
    assert result["truncated"] is True
    assert result["text_chars"] == len(response_text)
    assert len(result["text"]) == native_host.PROMPT_JOB_RESULT_TEXT_CHARS


def test_prompt_job_defaults_match_deep_research_ttls():
    assert native_host.PROMPT_JOB_CLAIM_TTL_SECONDS == 3600
    assert native_host.PROMPT_JOB_UNCLAIMED_TTL_SECONDS == 1800
    assert native_host.PROMPT_JOB_RESULT_MAX_AGE_SECONDS == 86400
    assert native_host.PROMPT_JOB_RESULT_TEXT_CHARS == 200000
    assert native_host.JOB_WATCH_MAX_UNREADABLE_AGE_SECONDS == 300


def test_finish_job_want_result_truncates_after_200000_chars(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    claimed_file = tmp_path / "job_boundary.claimed.worker_1.json"
    write_job(claimed_file, job_id="boundary", text="prompt text", want_result=True)
    response_text = "x" * 200001

    response = monitor.handle_message({
        "type": "finish_job",
        "folder": str(tmp_path),
        "claimedFile": claimed_file.name,
        "status": "done",
        "responseText": response_text,
    })

    result = json.loads((tmp_path / "result_boundary.json").read_text(encoding="utf-8"))
    assert response == {"type": "finish_result", "ok": True}
    assert result["truncated"] is True
    assert result["text_chars"] == 200001
    assert len(result["text"]) == 200000


def test_watch_jobs_claim_expired_writes_error_result(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    monitor.send_message = lambda message: None
    claimed_file = tmp_path / "job_expired.claimed.worker_1.json"
    write_job(claimed_file, job_id="expired", text="prompt text", want_result=True)
    old_time = time.time() - 10
    os.utime(claimed_file, (old_time, old_time))

    response = monitor.handle_message({
        "type": "watch_jobs",
        "folder": str(tmp_path),
        "pollMs": 25,
        "claimTtlSeconds": 1,
    })
    wait_for(lambda: (tmp_path / "result_expired.json").exists())
    monitor.stop_job_watcher()

    result = json.loads((tmp_path / "result_expired.json").read_text(encoding="utf-8"))
    assert response == {"type": "watch_started", "folder": str(tmp_path)}
    assert not claimed_file.exists()
    assert result["status"] == "error"
    assert result["error"] == "claim_expired"


def test_watch_jobs_unclaimed_want_result_job_expires_to_error_result(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    monitor.send_message = lambda message: None
    job_file = tmp_path / "job_unclaimed.json"
    write_job(job_file, job_id="unclaimed", text="prompt text", want_result=True)
    old_time = time.time() - 10
    os.utime(job_file, (old_time, old_time))

    response = monitor.handle_message({
        "type": "watch_jobs",
        "folder": str(tmp_path),
        "pollMs": 25,
        "unclaimedTtlSeconds": 1,
    })
    wait_for(lambda: (tmp_path / "result_unclaimed.json").exists())
    monitor.stop_job_watcher()

    result = json.loads((tmp_path / "result_unclaimed.json").read_text(encoding="utf-8"))
    assert response == {"type": "watch_started", "folder": str(tmp_path)}
    assert not job_file.exists()
    assert result["status"] == "error"
    assert result["error"] == "job_unclaimed_expired"


def test_watch_jobs_announces_old_want_result_job_before_unclaimed_ttl(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    sent = []
    monitor.send_message = sent.append
    job_file = tmp_path / "job_old_bridge.json"
    write_job(job_file, job_id="old_bridge", text="deep research", want_result=True)
    old_time = time.time() - (native_host.JOB_WATCH_MAX_UNREADABLE_AGE_SECONDS + 30)
    os.utime(job_file, (old_time, old_time))

    response = monitor.handle_message({
        "type": "watch_jobs",
        "folder": str(tmp_path),
        "pollMs": 25,
    })
    wait_for(lambda: len(job_messages(sent)) == 1)
    monitor.stop_job_watcher()

    messages = job_messages(sent)
    assert response == {"type": "watch_started", "folder": str(tmp_path)}
    assert messages[0]["jobFile"] == "job_old_bridge.json"
    assert messages[0]["wantResult"] is True
    assert job_file.exists()
    assert not (tmp_path / "result_old_bridge.json").exists()


def test_watch_jobs_unclaimed_voice_job_does_not_write_result(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    monitor.send_message = lambda message: None
    job_file = tmp_path / "job_voice_old.json"
    write_job(job_file, job_id="voice_old", text="voice prompt")
    old_time = time.time() - 10
    os.utime(job_file, (old_time, old_time))

    response = monitor.handle_message({
        "type": "watch_jobs",
        "folder": str(tmp_path),
        "pollMs": 25,
        "unclaimedTtlSeconds": 1,
    })
    time.sleep(0.08)
    monitor.stop_job_watcher()

    assert response == {"type": "watch_started", "folder": str(tmp_path)}
    assert job_file.exists()
    assert not (tmp_path / "result_voice_old.json").exists()


def test_watch_jobs_does_not_announce_old_voice_job(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    sent = []
    monitor.send_message = sent.append
    job_file = tmp_path / "job_old_voice.json"
    write_job(job_file, job_id="old_voice", text="voice prompt")
    old_time = time.time() - (native_host.JOB_WATCH_MAX_UNREADABLE_AGE_SECONDS + 30)
    os.utime(job_file, (old_time, old_time))

    response = monitor.handle_message({
        "type": "watch_jobs",
        "folder": str(tmp_path),
        "pollMs": 25,
    })
    time.sleep(0.08)
    monitor.stop_job_watcher()

    assert response == {"type": "watch_started", "folder": str(tmp_path)}
    assert job_messages(sent) == []
    assert "job_old_voice.json" not in monitor.job_watch_announced
    assert job_file.exists()


def test_result_writer_uses_tmp_then_replace():
    source = inspect.getsource(native_host.TranscriptionMonitor.write_result_file)
    assert ".tmp" in source
    assert "os.replace" in source


def test_watch_jobs_announces_once_and_reannounces_after_recreate(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    sent = []
    sent_lock = threading.Lock()

    def capture(message):
        with sent_lock:
            sent.append(message)

    monitor.send_message = capture
    response = monitor.handle_message({
        "type": "watch_jobs",
        "folder": str(tmp_path),
        "pollMs": 25,
    })
    assert response == {"type": "watch_started", "folder": str(tmp_path)}

    job_file = tmp_path / "job_watch.json"
    write_job(job_file, job_id="watch", text="first")
    wait_for(lambda: len(job_messages(sent)) == 1)
    time.sleep(0.08)
    assert len(job_messages(sent)) == 1

    job_file.unlink()
    wait_for(lambda: len(monitor.job_watch_announced) == 0)
    write_job(job_file, job_id="watch", text="second")
    wait_for(lambda: len(job_messages(sent)) == 2)
    monitor.stop_job_watcher()

    messages = job_messages(sent)
    assert [message["jobFile"] for message in messages] == ["job_watch.json", "job_watch.json"]
    assert [message["text"] for message in messages] == ["first", "second"]


def test_watch_jobs_retries_unreadable_payload_without_announcing(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    sent = []
    sent_lock = threading.Lock()

    def capture(message):
        with sent_lock:
            sent.append(message)

    monitor.send_message = capture
    response = monitor.handle_message({
        "type": "watch_jobs",
        "folder": str(tmp_path),
        "pollMs": 25,
    })
    assert response == {"type": "watch_started", "folder": str(tmp_path)}

    job_file = tmp_path / "job_retry.json"
    job_file.write_text("{", encoding="utf-8")
    time.sleep(0.08)
    assert job_messages(sent) == []
    assert "job_retry.json" not in monitor.job_watch_announced

    write_job(job_file, job_id="retry", text="ready")
    wait_for(lambda: len(job_messages(sent)) == 1)
    monitor.stop_job_watcher()

    messages = job_messages(sent)
    assert messages[0]["jobFile"] == "job_retry.json"
    assert messages[0]["id"] == "retry"
    assert messages[0]["text"] == "ready"


def test_claim_job_rejects_path_traversal_and_nested_paths(tmp_path):
    monitor = native_host.TranscriptionMonitor()
    outside = tmp_path.parent / "evil.json"
    outside.write_text("do not touch", encoding="utf-8")

    traversal_response = monitor.handle_message({
        "type": "claim_job",
        "folder": str(tmp_path),
        "jobFile": "..\\evil.json",
        "claimantId": "worker",
    })
    nested_response = monitor.handle_message({
        "type": "claim_job",
        "folder": str(tmp_path),
        "jobFile": "sub/dir.json",
        "claimantId": "worker",
    })

    assert traversal_response["type"] in {"claim_result", "error"}
    assert nested_response["type"] in {"claim_result", "error"}
    assert traversal_response.get("ok") is False
    assert nested_response.get("ok") is False
    assert outside.read_text(encoding="utf-8") == "do not touch"


def job_messages(messages):
    return [message for message in messages if message.get("type") == "job_found"]


def wait_for(predicate, timeout=1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    assert predicate()
