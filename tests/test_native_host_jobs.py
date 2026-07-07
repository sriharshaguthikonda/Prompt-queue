import json
import threading
import time

import native_host


def write_job(path, job_id="abc", text="hello"):
    path.write_text(
        json.dumps({"id": job_id, "text": text, "ts": 123}),
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
