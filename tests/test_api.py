import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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


def test_faculty_exam_roster_and_attempt_management(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "management-test.db")

    with TestClient(server.app) as client:
        assert client.get("/faculty/exam").status_code == 401
        assert client.get("/faculty/candidates").status_code == 401
        assert client.get("/faculty/sessions").status_code == 401

        assert client.post("/faculty/unlock", json={"pin": "test-faculty-pin"}).status_code == 200

        config = client.get("/faculty/exam")
        assert config.status_code == 200
        assert config.json()["status"] == "OPEN"

        saved = client.put("/faculty/exam", json={
            "title": "DSA Practical",
            "duration_minutes": 90,
            "status": "OPEN",
            "starts_at": None,
            "ends_at": None,
        })
        assert saved.status_code == 200
        assert saved.json()["title"] == "DSA Practical"

        candidate = client.post("/faculty/candidates", json={
            "student_name": "Roster Candidate",
            "terminal_id": "lab-c-04",
        })
        assert candidate.status_code == 201
        candidate_id = candidate.json()["id"]
        assert candidate.json()["terminal_id"] == "LAB-C-04"

        duplicate_seat = client.post("/faculty/candidates", json={
            "student_name": "Another Candidate",
            "terminal_id": "LAB-C-04",
        })
        assert duplicate_seat.status_code == 409

        wrong_seat = client.post("/authenticate", json={
            "student_name": "Roster Candidate",
            "terminal_id": "LAB-C-05",
            "pin": "test-exam-pin",
        })
        assert wrong_seat.status_code == 403

        auth = client.post("/authenticate", json={
            "student_name": "Roster Candidate",
            "terminal_id": "LAB-C-04",
            "pin": "test-exam-pin",
        })
        assert auth.status_code == 200
        session_id = auth.json()["session_id"]
        assert auth.json()["exam_title"] == "DSA Practical"
        assert auth.json()["duration_minutes"] == 90

        sessions = client.get("/faculty/sessions")
        assert sessions.status_code == 200
        assert sessions.json()["sessions"][0]["student_name"] == "Roster Candidate"

        finalized = client.post(f"/faculty/sessions/{session_id}/status", json={
            "status": "COMPLETED",
            "reason": "Submitted normally",
        })
        assert finalized.status_code == 200
        assert finalized.json()["attempt_status"] == "COMPLETED"

        duplicate_finalize = client.post(f"/faculty/sessions/{session_id}/status", json={
            "status": "CANCELLED",
        })
        assert duplicate_finalize.status_code == 409

        assert client.delete(f"/faculty/candidates/{candidate_id}").status_code == 200
        denied_after_deactivation = client.post("/authenticate", json={
            "student_name": "Roster Candidate",
            "terminal_id": "LAB-C-04",
            "pin": "test-exam-pin",
        })
        assert denied_after_deactivation.status_code == 403

        reassigned = client.post("/faculty/candidates", json={
            "student_name": "Replacement Candidate",
            "terminal_id": "LAB-C-04",
        })
        assert reassigned.status_code == 201
        assert reassigned.json()["student_name"] == "Replacement Candidate"
        assert reassigned.json()["active"] == 1


def test_paused_exam_blocks_new_candidate_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "paused-test.db")

    with TestClient(server.app) as client:
        client.post("/faculty/unlock", json={"pin": "test-faculty-pin"})
        paused = client.put("/faculty/exam", json={
            "title": "Paused exam",
            "duration_minutes": 45,
            "status": "PAUSED",
        })
        assert paused.status_code == 200

        auth = client.post("/authenticate", json={
            "student_name": "Candidate",
            "terminal_id": "LAB-Z-01",
            "pin": "test-exam-pin",
        })
        assert auth.status_code == 403


def test_exam_duration_expiry_and_csv_export(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "duration-test.db")

    with TestClient(server.app) as client:
        client.post("/faculty/unlock", json={"pin": "test-faculty-pin"})
        client.put("/faculty/exam", json={
            "title": "Timed test", "duration_minutes": 1, "status": "OPEN",
        })
        auth = client.post("/authenticate", json={
            "student_name": "Timed Candidate",
            "terminal_id": "LAB-T-01",
            "pin": "test-exam-pin",
        })
        assert auth.status_code == 200
        session_id = auth.json()["session_id"]

        with server.db_connection() as conn:
            conn.execute(
                "UPDATE sessions SET started_at=datetime('now','-2 minutes') WHERE id=?",
                (session_id,),
            )
            conn.commit()

        attempts = client.get("/faculty/sessions")
        assert attempts.status_code == 200
        assert attempts.json()["sessions"][0]["status"] == "COMPLETED"
        assert attempts.json()["sessions"][0]["completion_reason"] == "Examination duration elapsed"

        export = client.get("/faculty/export/incidents.csv")
        assert export.status_code == 200
        assert "text/csv" in export.headers["content-type"]
        assert export.text.startswith("Incident ID,Timestamp,Candidate,Terminal,Violation")


def test_scheduled_exam_rejects_early_candidate_login(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "schedule-test.db")

    with TestClient(server.app) as client:
        client.post("/faculty/unlock", json={"pin": "test-faculty-pin"})
        saved = client.put("/faculty/exam", json={
            "title": "Future exam",
            "duration_minutes": 60,
            "status": "OPEN",
            "starts_at": "2999-01-01T09:00",
            "ends_at": None,
        })
        assert saved.status_code == 200

        auth = client.post("/authenticate", json={
            "student_name": "Early Candidate",
            "terminal_id": "LAB-F-01",
            "pin": "test-exam-pin",
        })
        assert auth.status_code == 403
        assert "not started" in auth.json()["detail"].lower()


def test_authentication_rate_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "rate-limit-test.db")
    monkeypatch.setattr(server, "_auth_failures", {})

    with TestClient(server.app) as client:
        payload = {
            "student_name": "Candidate",
            "terminal_id": "LAB-R-01",
            "pin": "incorrect",
        }
        for _ in range(server.AUTH_FAILURE_LIMIT):
            assert client.post("/authenticate", json=payload).status_code == 401
        limited = client.post("/authenticate", json=payload)
        assert limited.status_code == 429
