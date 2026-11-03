from __future__ import annotations

import asyncio
import csv
import io
import base64
import binascii
import hashlib
import hmac
import os
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

BASE_PATH = Path(__file__).resolve().parent
REPOSITORY_ROOT = BASE_PATH
LEGACY_ASSETS = BASE_PATH / "lablock_final"
DB_PATH = Path(os.getenv("LABLOCK_DB_PATH", str(LEGACY_ASSETS / "lablock.db"))).resolve()
MODEL_PATH = Path(os.getenv("LABLOCK_MODEL_PATH", str(LEGACY_ASSETS / "yolov8n.pt"))).resolve()
try:
    MAX_AI_WORKERS = max(1, min(4, int(os.getenv("LABLOCK_AI_WORKERS", "2"))))
except ValueError:
    MAX_AI_WORKERS = 2
MAX_FRAME_BYTES = 2_000_000
MAX_FRAME_WIDTH = 1280
MAX_FRAME_HEIGHT = 960
MIN_INFERENCE_INTERVAL = 0.35
COOLDOWN_WINDOW_SECONDS = 8

_ai_executor = ThreadPoolExecutor(max_workers=MAX_AI_WORKERS, thread_name_prefix="lablock-ai")
_ai_semaphore = asyncio.Semaphore(MAX_AI_WORKERS)
_ai_local = threading.local()
_db_write_lock = threading.Lock()
_cooldown_lock = threading.Lock()
_active_lock = threading.Lock()
_active_connections: dict[str, dict[str, Any]] = {}
_violation_cooldowns: dict[tuple[str, str, str], float] = {}
_model_load_error: str | None = None


class ViolationRequest(BaseModel):
    student_name: str = Field(min_length=1, max_length=120)
    violation_type: str = Field(min_length=1, max_length=160)
    terminal_id: str = Field(default="UNKNOWN", max_length=80)
    session_id: str = Field(min_length=1, max_length=64)

    @field_validator("student_name", "violation_type", "terminal_id")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()


class AuthRequest(BaseModel):
    student_name: str = Field(min_length=1, max_length=120)
    terminal_id: str = Field(min_length=1, max_length=80)
    pin: str = Field(min_length=1, max_length=128)


class FacultyAuthRequest(BaseModel):
    pin: str = Field(min_length=1, max_length=128)


class CandidateRegistration(BaseModel):
    student_name: str = Field(min_length=1, max_length=120)
    terminal_id: str = Field(min_length=1, max_length=80)

    @field_validator("student_name", "terminal_id")
    @classmethod
    def clean_registration(cls, value: str) -> str:
        return value.strip()


class ExamConfiguration(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    duration_minutes: int = Field(ge=1, le=600)
    status: str = Field(default="OPEN", pattern="^(OPEN|PAUSED|CLOSED)$")
    starts_at: str | None = Field(default=None, max_length=40)
    ends_at: str | None = Field(default=None, max_length=40)


class SessionStatusUpdate(BaseModel):
    status: str = Field(pattern="^(COMPLETED|CANCELLED)$")
    reason: str | None = Field(default=None, max_length=240)


def _connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=20000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

@contextmanager
def db_connection():
    conn = _connect_db()
    try:
        yield conn
    finally:
        conn.close()


def setup_database() -> None:
    with db_connection() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS violations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_name TEXT NOT NULL,
                violation_type TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                terminal_id TEXT NOT NULL DEFAULT 'UNKNOWN'
            )
        """)
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(violations)")}
        if "terminal_id" not in columns:
            conn.execute("ALTER TABLE violations ADD COLUMN terminal_id TEXT NOT NULL DEFAULT 'UNKNOWN'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_violations_timestamp ON violations(timestamp)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_violations_student ON violations(student_name)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                student_name TEXT NOT NULL,
                terminal_id TEXT NOT NULL,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at DATETIME,
                status TEXT NOT NULL DEFAULT 'ACTIVE'
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(status, last_seen_at)")
        session_columns = {row["name"] for row in conn.execute("PRAGMA table_info(sessions)")}
        if "completion_reason" not in session_columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN completion_reason TEXT")
        if "duration_minutes" not in session_columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 0")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_name TEXT NOT NULL,
                terminal_id TEXT NOT NULL UNIQUE,
                active INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_candidates_name ON candidates(student_name)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS exam_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                title TEXT NOT NULL,
                duration_minutes INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'OPEN',
                starts_at TEXT,
                ends_at TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()


def _thread_models() -> tuple[Any, Any, bool]:
    global _model_load_error
    if getattr(_ai_local, "initialized", False):
        return _ai_local.yolo, _ai_local.face_mesh, _ai_local.use_mediapipe
    from ultralytics import YOLO

    if not MODEL_PATH.is_file():
        raise FileNotFoundError(f"YOLO model file not found: {MODEL_PATH}")
    yolo = YOLO(str(MODEL_PATH))
    face_mesh = None
    use_mediapipe = False
    try:
        import mediapipe as mp
        face_mesh = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=True,
            max_num_faces=3,
            refine_landmarks=False,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        use_mediapipe = True
    except (ImportError, AttributeError, RuntimeError) as exc:
        print(f"[LabLock] MediaPipe unavailable; using OpenCV face detector: {exc}")
    _ai_local.yolo = yolo
    _ai_local.face_mesh = face_mesh
    _ai_local.use_mediapipe = use_mediapipe
    _ai_local.face_cascade = None
    _ai_local.initialized = True
    _model_load_error = None
    return yolo, face_mesh, use_mediapipe


def _face_fallback(frame: np.ndarray) -> tuple[int, bool]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    cascade = getattr(_ai_local, "face_cascade", None)
    if cascade is None:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        _ai_local.face_cascade = cascade
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    return len(faces), False


def run_ai_proctoring(frame: np.ndarray) -> list[str]:
    """Run inference using thread-local model instances; no global inference mutex."""
    yolo, face_mesh, use_mediapipe = _thread_models()
    alerts: list[str] = []
    results = yolo.predict(frame, verbose=False, conf=0.35, imgsz=640)
    if results and results[0].boxes is not None:
        names = yolo.names
        for box in results[0].boxes:
            class_id = int(box.cls.item())
            label = names.get(class_id, str(class_id)) if isinstance(names, dict) else names[class_id]
            if label == "cell phone":
                alerts.append("Mobile Phone Detected")
                break

    if use_mediapipe and face_mesh is not None:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        face_results = face_mesh.process(rgb)
        faces = face_results.multi_face_landmarks or []
        if len(faces) == 0:
            alerts.append("Candidate Absent / Face Not Detected")
        elif len(faces) > 1:
            alerts.append("Multiple Persons in Camera View")
        else:
            landmarks = faces[0].landmark
            left_x, right_x, nose_x = landmarks[234].x, landmarks[454].x, landmarks[1].x
            left_dist, right_dist = nose_x - left_x, right_x - nose_x
            if left_dist <= 0 or right_dist <= 0:
                alerts.append("Looking Off-Screen")
            else:
                ratio = left_dist / right_dist
                if ratio > 3.5 or ratio < 0.25:
                    alerts.append("Looking Off-Screen")
    else:
        face_count, _ = _face_fallback(frame)
        if face_count == 0:
            alerts.append("Candidate Absent / Face Not Detected")
        elif face_count > 1:
            alerts.append("Multiple Persons in Camera View")
    return alerts


def should_log_violation(student_name: str, terminal_id: str, violation_type: str) -> bool:
    now = time.monotonic()
    key = (student_name, terminal_id, violation_type)
    with _cooldown_lock:
        previous = _violation_cooldowns.get(key, 0.0)
        if now - previous < COOLDOWN_WINDOW_SECONDS:
            return False
        _violation_cooldowns[key] = now
        if len(_violation_cooldowns) > 5000:
            cutoff = now - COOLDOWN_WINDOW_SECONDS * 3
            for old_key, timestamp in list(_violation_cooldowns.items()):
                if timestamp < cutoff:
                    _violation_cooldowns.pop(old_key, None)
        return True


def log_violation_to_db(student_name: str, violation_type: str, terminal_id: str = "UNKNOWN") -> None:
    with _db_write_lock, db_connection() as conn:
        conn.execute(
            "INSERT INTO violations (student_name, violation_type, terminal_id) VALUES (?, ?, ?)",
            (student_name, violation_type, terminal_id),
        )
        conn.commit()


def authenticate_candidate(payload: AuthRequest) -> bool:
    expected = os.getenv("EXAM_ACCESS_PIN", "")
    return bool(expected) and payload.pin == expected


def authenticate_faculty(payload: FacultyAuthRequest) -> bool:
    expected = os.getenv("FACULTY_PIN", "")
    return bool(expected) and payload.pin == expected


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _model_load_error
    setup_database()
    try:
        await asyncio.get_running_loop().run_in_executor(_ai_executor, _thread_models)
    except Exception as exc:
        _model_load_error = str(exc)
        print(f"[LabLock] AI model warm-up failed: {exc}")
    yield
    for conn in list(_active_connections.values()):
        try:
            await conn["websocket"].close(code=1001, reason="Server shutting down")
        except Exception:
            pass


app = FastAPI(title="LabLock Proctoring & Invigilation Engine", lifespan=lifespan)
allowed_origins = [x.strip() for x in os.getenv("LABLOCK_ALLOWED_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:5500,http://localhost:5500").split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "database": DB_PATH.exists(),
        "ai_ready": _model_load_error is None,
        "ai_error": _model_load_error,
        "ai_workers": MAX_AI_WORKERS,
        "active_terminals": _active_session_count(),
    }


@app.post("/authenticate")
async def authenticate(payload: AuthRequest):
    if not authenticate_candidate(payload):
        raise HTTPException(status_code=401, detail="Invalid examination credentials.")
    student_name = payload.student_name.strip()
    terminal_id = payload.terminal_id.strip().upper()
    session_id = uuid.uuid4().hex
    with db_connection() as conn:
        config = conn.execute("SELECT status FROM exam_config WHERE id=1").fetchone()
        if config and config["status"] != "OPEN":
            raise HTTPException(status_code=403, detail="The examination is not currently accepting candidates.")
        roster_size = conn.execute("SELECT COUNT(*) AS n FROM candidates").fetchone()["n"]
        if roster_size:
            registered = conn.execute(
                "SELECT 1 FROM candidates WHERE active=1 AND lower(student_name)=lower(?) AND terminal_id=?",
                (student_name, terminal_id),
            ).fetchone()
            if not registered:
                raise HTTPException(status_code=403, detail="Candidate name and seat are not present in the active examination roster.")
        _expire_sessions(conn)
        conn.execute("UPDATE sessions SET status='ENDED', ended_at=CURRENT_TIMESTAMP WHERE status='ACTIVE' AND last_seen_at < datetime('now','-45 seconds')")
        active = conn.execute(
            "SELECT id FROM sessions WHERE terminal_id=? AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1",
            (terminal_id,),
        ).fetchone()
        if active:
            raise HTTPException(status_code=409, detail="This terminal already has an active examination session.")
        config_duration = conn.execute("SELECT duration_minutes FROM exam_config WHERE id=1").fetchone()
        duration_minutes = int(config_duration["duration_minutes"]) if config_duration else 0
        conn.execute(
            "INSERT INTO sessions (id, student_name, terminal_id, duration_minutes) VALUES (?, ?, ?, ?)",
            (session_id, student_name, terminal_id, duration_minutes),
        )
        conn.commit()
    return {"status": "OK", "session_id": session_id, "student_name": student_name, "terminal_id": terminal_id}


@app.post("/faculty/unlock")
async def faculty_unlock(payload: FacultyAuthRequest, request: Request, response: Response):
    if not authenticate_faculty(payload):
        raise HTTPException(status_code=401, detail="Invalid faculty authorization key.")
    expires = int(time.time()) + 8 * 60 * 60
    secret = os.getenv("LABLOCK_SESSION_SECRET") or os.getenv("FACULTY_PIN", "")
    signature = hmac.new(secret.encode("utf-8"), str(expires).encode("ascii"), hashlib.sha256).hexdigest()
    response.set_cookie(
        "lablock_faculty", f"{expires}.{signature}", max_age=8 * 60 * 60,
        httponly=True, secure=request.url.scheme == "https", samesite="lax", path="/",
    )
    return {"status": "OK"}


@app.post("/log-violation")
async def log_violation_endpoint(payload: ViolationRequest):
    def session_is_active():
        with db_connection() as conn:
            return conn.execute(
                "SELECT 1 FROM sessions WHERE id=? AND student_name=? AND terminal_id=? AND status='ACTIVE'",
                (payload.session_id, payload.student_name, payload.terminal_id),
            ).fetchone() is not None
    if not await asyncio.to_thread(session_is_active):
        raise HTTPException(status_code=403, detail="An active candidate session is required to report an incident.")
    if should_log_violation(payload.student_name, payload.terminal_id, payload.violation_type):
        await asyncio.to_thread(log_violation_to_db, payload.student_name, payload.violation_type, payload.terminal_id)
    return {"status": "OK"}


def has_faculty_session(request: Request) -> bool:
    token = request.cookies.get("lablock_faculty", "")
    try:
        expires_text, supplied = token.split(".", 1)
        expires = int(expires_text)
        if expires < int(time.time()):
            return False
        secret = os.getenv("LABLOCK_SESSION_SECRET") or os.getenv("FACULTY_PIN", "")
        if not secret:
            return False
        expected = hmac.new(secret.encode("utf-8"), expires_text.encode("ascii"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(supplied, expected)
    except (ValueError, TypeError):
        return False



def _expire_sessions(conn: sqlite3.Connection) -> None:
    conn.execute("""
        UPDATE sessions SET status='COMPLETED', ended_at=CURRENT_TIMESTAMP,
            completion_reason='Examination duration elapsed'
        WHERE status='ACTIVE' AND duration_minutes > 0
          AND datetime(started_at, '+' || duration_minutes || ' minutes') <= CURRENT_TIMESTAMP
    """)


def _active_session_count() -> int:
    try:
        with db_connection() as conn:
            _expire_sessions(conn)
            conn.commit()
            return int(conn.execute(
                "SELECT COUNT(*) AS n FROM sessions WHERE status='ACTIVE' AND last_seen_at >= datetime('now','-45 seconds')"
            ).fetchone()["n"])
    except sqlite3.Error:
        return 0


def require_faculty(request: Request) -> None:
    if not has_faculty_session(request):
        raise HTTPException(status_code=401, detail="Faculty authorization required.")


@app.get("/faculty/exam")
async def faculty_get_exam(request: Request):
    require_faculty(request)
    with db_connection() as conn:
        row = conn.execute("SELECT * FROM exam_config WHERE id=1").fetchone()
        return dict(row) if row else {
            "id": 1, "title": "LabLock Examination", "duration_minutes": 60,
            "status": "OPEN", "starts_at": None, "ends_at": None, "updated_at": None,
        }


@app.put("/faculty/exam")
async def faculty_set_exam(payload: ExamConfiguration, request: Request):
    require_faculty(request)
    with db_connection() as conn:
        conn.execute("""
            INSERT INTO exam_config (id, title, duration_minutes, status, starts_at, ends_at, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,
                duration_minutes=excluded.duration_minutes, status=excluded.status,
                starts_at=excluded.starts_at, ends_at=excluded.ends_at,
                updated_at=CURRENT_TIMESTAMP
        """, (payload.title.strip(), payload.duration_minutes, payload.status,
              payload.starts_at, payload.ends_at))
        conn.commit()
        return dict(conn.execute("SELECT * FROM exam_config WHERE id=1").fetchone())


@app.get("/faculty/candidates")
async def faculty_list_candidates(request: Request):
    require_faculty(request)
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM candidates ORDER BY student_name COLLATE NOCASE").fetchall()
        return {"candidates": [dict(row) for row in rows]}


@app.post("/faculty/candidates", status_code=201)
async def faculty_add_candidate(payload: CandidateRegistration, request: Request):
    require_faculty(request)
    name = payload.student_name.strip()
    terminal = payload.terminal_id.strip().upper()
    if not name or not terminal:
        raise HTTPException(status_code=422, detail="Candidate name and terminal are required.")
    try:
        with db_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO candidates (student_name, terminal_id) VALUES (?, ?)", (name, terminal)
            )
            conn.commit()
            return dict(conn.execute("SELECT * FROM candidates WHERE id=?", (cursor.lastrowid,)).fetchone())
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="That terminal is already assigned in the roster.") from exc


@app.delete("/faculty/candidates/{candidate_id}")
async def faculty_deactivate_candidate(candidate_id: int, request: Request):
    require_faculty(request)
    with db_connection() as conn:
        cursor = conn.execute("UPDATE candidates SET active=0 WHERE id=?", (candidate_id,))
        conn.commit()
        if not cursor.rowcount:
            raise HTTPException(status_code=404, detail="Candidate not found.")
    return {"status": "OK", "candidate_id": candidate_id, "active": False}


@app.get("/faculty/sessions")
async def faculty_list_sessions(request: Request):
    require_faculty(request)
    with db_connection() as conn:
        _expire_sessions(conn)
        conn.commit()
        rows = conn.execute("""
            SELECT id, student_name, terminal_id, started_at, last_seen_at, ended_at, status, completion_reason
            FROM sessions ORDER BY started_at DESC LIMIT 500
        """).fetchall()
        return {"sessions": [dict(row) for row in rows]}


@app.post("/faculty/sessions/{session_id}/status")
async def faculty_update_session_status(session_id: str, payload: SessionStatusUpdate, request: Request):
    require_faculty(request)
    with db_connection() as conn:
        cursor = conn.execute("""
            UPDATE sessions SET status=?, ended_at=CURRENT_TIMESTAMP, completion_reason=?
            WHERE id=? AND status IN ('ACTIVE','ENDED')
        """, (payload.status, payload.reason, session_id))
        conn.commit()
        if not cursor.rowcount:
            exists = conn.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone()
            if not exists:
                raise HTTPException(status_code=404, detail="Session not found.")
            raise HTTPException(status_code=409, detail="This attempt is already finalized.")
    with _active_lock:
        for connection in list(_active_connections.values()):
            if connection.get("session_id") == session_id:
                try:
                    asyncio.create_task(connection["websocket"].close(code=1008, reason="Attempt finalized by faculty"))
                except RuntimeError:
                    pass
    return {"status": "OK", "session_id": session_id, "attempt_status": payload.status}


@app.get("/faculty/export/incidents.csv")
async def faculty_export_incidents(request: Request):
    require_faculty(request)
    def build_csv() -> str:
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["Incident ID", "Timestamp", "Candidate", "Terminal", "Violation"])
        with db_connection() as conn:
            rows = conn.execute("SELECT id, timestamp, student_name, terminal_id, violation_type FROM violations ORDER BY timestamp DESC").fetchall()
            for row in rows:
                writer.writerow([row["id"], row["timestamp"], row["student_name"], row["terminal_id"], row["violation_type"]])
        return output.getvalue()
    content = await asyncio.to_thread(build_csv)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="lablock-incidents.csv"'},
    )


@app.get("/get-logs")
async def get_logs_endpoint(request: Request):
    if not has_faculty_session(request):
        raise HTTPException(status_code=401, detail="Faculty authorization required.")
    try:
        def read_logs():
            with db_connection() as conn:
                rows = conn.execute("SELECT * FROM violations ORDER BY timestamp DESC LIMIT 500").fetchall()
                active = conn.execute(
                    "SELECT COUNT(*) AS n FROM sessions WHERE status='ACTIVE' AND last_seen_at >= datetime('now','-45 seconds')"
                ).fetchone()["n"]
                total = conn.execute("SELECT COUNT(*) AS n FROM violations").fetchone()["n"]
                return [dict(row) for row in rows], int(active), int(total)
        logs, active, total = await asyncio.to_thread(read_logs)
        return {"logs": logs, "active_terminals": active, "total_incidents": total}
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Audit database temporarily unavailable.") from exc


@app.post("/session/heartbeat")
async def session_heartbeat(payload: dict):
    session_id = str(payload.get("session_id", ""))
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")
    def update():
        with db_connection() as conn:
            _expire_sessions(conn)
            cursor = conn.execute(
                "UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=? AND status='ACTIVE'",
                (session_id,),
            )
            conn.commit()
            return cursor.rowcount
    changed = await asyncio.to_thread(update)
    if not changed:
        raise HTTPException(status_code=404, detail="Active session not found")
    return {"status": "OK"}


@app.post("/session/end")
async def session_end(payload: dict):
    session_id = str(payload.get("session_id", ""))
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")
    def finish():
        with db_connection() as conn:
            cursor = conn.execute(
                "UPDATE sessions SET status='ENDED', ended_at=CURRENT_TIMESTAMP WHERE id=? AND status='ACTIVE'",
                (session_id,),
            )
            conn.commit()
            return cursor.rowcount
    changed = await asyncio.to_thread(finish)
    if not changed:
        raise HTTPException(status_code=404, detail="Active session not found")
    return {"status": "OK"}


@app.websocket("/ws/proctor/{student_name}")
async def proctor_endpoint(websocket: WebSocket, student_name: str):
    connection_id = uuid.uuid4().hex
    terminal_id = websocket.query_params.get("terminal_id", "UNKNOWN")[:80]
    session_id = websocket.query_params.get("session_id", "")
    def valid_session():
        with db_connection() as conn:
            return conn.execute(
                "SELECT id FROM sessions WHERE id=? AND student_name=? AND terminal_id=? AND status='ACTIVE'",
                (session_id, student_name[:120], terminal_id),
            ).fetchone() is not None
    if not session_id or not await asyncio.to_thread(valid_session):
        await websocket.close(code=1008, reason="Valid active candidate session required")
        return
    await websocket.accept()
    with _active_lock:
        _active_connections[connection_id] = {
            "student_name": student_name[:120],
            "terminal_id": terminal_id,
            "session_id": session_id,
            "websocket": websocket,
            "connected_at": time.time(),
        }
    last_inference = 0.0
    alert_streaks = {
        "Mobile Phone Detected": 0,
        "Candidate Absent / Face Not Detected": 0,
        "Multiple Persons in Camera View": 0,
        "Looking Off-Screen": 0,
    }
    alert_thresholds = {
        "Mobile Phone Detected": 2,
        "Candidate Absent / Face Not Detected": 3,
        "Multiple Persons in Camera View": 2,
        "Looking Off-Screen": 2,
    }
    try:
        while True:
            data = await websocket.receive_text()
            now = time.monotonic()
            if now - last_inference < MIN_INFERENCE_INTERVAL:
                await websocket.send_json({"status": "SKIPPED", "reason": "inference_rate_limit"})
                continue
            if len(data) > (MAX_FRAME_BYTES * 4 // 3 + 256):
                await websocket.send_json({"status": "ERROR", "message": "Frame exceeds size limit"})
                continue
            encoded = data.split(",", 1)[1] if data.startswith("data:") and "," in data else data
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                await websocket.send_json({"status": "ERROR", "message": "Invalid frame encoding"})
                continue
            if not raw or len(raw) > MAX_FRAME_BYTES:
                await websocket.send_json({"status": "ERROR", "message": "Invalid frame size"})
                continue
            image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                await websocket.send_json({"status": "ERROR", "message": "Invalid image"})
                continue
            height, width = image.shape[:2]
            if width > MAX_FRAME_WIDTH or height > MAX_FRAME_HEIGHT:
                scale = min(MAX_FRAME_WIDTH / width, MAX_FRAME_HEIGHT / height)
                image = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
            last_inference = now
            loop = asyncio.get_running_loop()
            try:
                await asyncio.wait_for(_ai_semaphore.acquire(), timeout=1.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"status": "SKIPPED", "reason": "ai_workers_busy"})
                continue
            try:
                alerts = await loop.run_in_executor(_ai_executor, run_ai_proctoring, image)
            except Exception as exc:
                global _model_load_error
                _model_load_error = str(exc)
                await websocket.send_json({"status": "ERROR", "message": "AI inference temporarily unavailable"})
                continue
            finally:
                _ai_semaphore.release()
            detected = set(alerts)
            confirmed_alerts = []
            for message, threshold in alert_thresholds.items():
                alert_streaks[message] = alert_streaks[message] + 1 if message in detected else 0
                if alert_streaks[message] >= threshold:
                    confirmed_alerts.append(message)
                    alert_streaks[message] = 0
            for message in confirmed_alerts:
                if should_log_violation(student_name, terminal_id, message):
                    await asyncio.to_thread(log_violation_to_db, student_name, message, terminal_id)
            if confirmed_alerts:
                await websocket.send_json({"status": "VIOLATION", "messages": confirmed_alerts, "message": confirmed_alerts[0]})
            else:
                await websocket.send_json({"status": "OK"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[LabLock] WebSocket failure for {student_name}: {exc}")
    finally:
        with _active_lock:
            _active_connections.pop(connection_id, None)


@app.get("/")
@app.get("/index.html")
async def serve_index():
    return FileResponse(REPOSITORY_ROOT / "index.html")


@app.get("/dashboard")
@app.get("/dashboard.html")
async def serve_dashboard():
    return FileResponse(REPOSITORY_ROOT / "dashboard.html")


@app.get("/styles.css")
async def serve_styles():
    return FileResponse(REPOSITORY_ROOT / "styles.css", media_type="text/css")


@app.get("/app.js")
async def serve_js():
    return FileResponse(REPOSITORY_ROOT / "app.js", media_type="application/javascript")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
