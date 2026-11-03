import os

os.environ["EXAM_ACCESS_PIN"] = "test-exam-pin"
os.environ["FACULTY_PIN"] = "test-faculty-pin"

import pytest
from fastapi.testclient import TestClient

import server


def test_candidate_faculty_audit_and_session_lifecycle(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "lablock-test.db")

    with TestClient(server.app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["database"] is True

        assert client.get("/get-logs").status_code == 401

        bad_auth = client.post("/authenticate", json={
            "student_name": "Test Candidate",
            "terminal_id": "LAB-A-01",
            "pin": "wrong",
        })
        assert bad_auth.status_code == 401

        auth = client.post("/authenticate", json={
            "student_name": "Test Candidate",
            "terminal_id": "lab-a-01",
            "pin": "test-exam-pin",
        })
        assert auth.status_code == 200
        session_id = auth.json()["session_id"]

        duplicate = client.post("/authenticate", json={
            "student_name": "Second Candidate",
            "terminal_id": "LAB-A-01",
            "pin": "test-exam-pin",
        })
        assert duplicate.status_code == 409

        with client.websocket_connect(
            f"/ws/proctor/Test%20Candidate?terminal_id=LAB-A-01&session_id={session_id}"
        ) as socket:
            socket.send_text("not-a-valid-frame")
            assert socket.receive_json()["status"] == "ERROR"

        violation = client.post("/log-violation", json={
            "student_name": "Test Candidate",
            "terminal_id": "LAB-A-01",
            "session_id": session_id,
            "violation_type": "Test incident",
        })
        assert violation.status_code == 200

        unlock = client.post("/faculty/unlock", json={"pin": "test-faculty-pin"})
        assert unlock.status_code == 200
        logs = client.get("/get-logs")
        assert logs.status_code == 200
        assert logs.json()["total_incidents"] == 1
        assert logs.json()["logs"][0]["terminal_id"] == "LAB-A-01"

        heartbeat = client.post("/session/heartbeat", json={"session_id": session_id})
        assert heartbeat.status_code == 200
        ended = client.post("/session/end", json={"session_id": session_id})
        assert ended.status_code == 200
        assert client.post("/session/heartbeat", json={"session_id": session_id}).status_code == 404
