from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import sqlite3
import cv2
import numpy as np
import base64
import os
import time
import asyncio
import threading
from ultralytics import YOLO
import mediapipe as mp

BASE_PATH = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_PATH, "lablock.db")

app = FastAPI(title="LabLock Proctoring & Invigilation Engine")

# 1. Initialize AI Models
model = YOLO("yolov8n.pt")

# Safe initialization for MediaPipe Face Mesh across different versions
try:
    mp_face_mesh = mp.solutions.face_mesh
    face_mesh = mp_face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=2,
        min_detection_confidence=0.5
    )
    USE_MEDIAPIPE_MESH = True
except AttributeError:
    print("WARNING: mp.solutions not found in this mediapipe build. Falling back to OpenCV Cascade Detector.")
    USE_MEDIAPIPE_MESH = False
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

ai_lock = threading.Lock()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

active_connections = set()
violation_cooldowns = {}
COOLDOWN_WINDOW_SECONDS = 8


class ViolationRequest(BaseModel):
    student_name: str
    violation_type: str


def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def setup_database():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_name TEXT,
            violation_type TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()


setup_database()


def should_log_violation(student_name: str, violation_type: str) -> bool:
    now = time.time()
    if student_name not in violation_cooldowns:
        violation_cooldowns[student_name] = {}

    last_time = violation_cooldowns[student_name].get(violation_type, 0)
    if now - last_time >= COOLDOWN_WINDOW_SECONDS:
        violation_cooldowns[student_name][violation_type] = now
        return True
    return False


def log_violation_to_db(student_name: str, violation_type: str):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO violations (student_name, violation_type) VALUES (?, ?)",
            (student_name, violation_type)
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Database write error for {student_name}: {e}")


@app.post("/log-violation")
async def log_violation_endpoint(payload: ViolationRequest):
    if should_log_violation(payload.student_name, payload.violation_type):
        await asyncio.to_thread(log_violation_to_db, payload.student_name, payload.violation_type)
    return {"status": "OK"}


@app.get("/get-logs")
async def get_logs_endpoint():
    try:
        conn = get_db_connection()
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM violations ORDER BY timestamp DESC LIMIT 200")
        logs = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return {
            "logs": logs,
            "active_terminals": len(active_connections)
        }
    except Exception as e:
        return {"logs": [], "active_terminals": len(active_connections), "error": str(e)}


def run_ai_proctoring(frame):
    with ai_lock:
        # AI Test 1: YOLO Cell Phone Detection
        results = model(frame, verbose=False)
        detected_objects = [model.names[int(box.cls)] for box in results[0].boxes]

        if "cell phone" in detected_objects:
            return True, "Mobile Phone Detected"

        # AI Test 2: Face & Head Tracking (MediaPipe or Fallback)
        if USE_MEDIAPIPE_MESH:
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mesh_results = face_mesh.process(frame_rgb)

            if not mesh_results.multi_face_landmarks:
                return True, "Candidate Absent / Face Not Detected"

            if len(mesh_results.multi_face_landmarks) > 1:
                return True, "Multiple Persons in Camera View"

            face_landmarks = mesh_results.multi_face_landmarks[0]
            left_x = face_landmarks.landmark[234].x
            right_x = face_landmarks.landmark[454].x
            nose_x = face_landmarks.landmark[1].x

            left_dist = nose_x - left_x
            right_dist = right_x - nose_x

            if right_dist <= 0 or left_dist <= 0:
                return True, "Looking Off-Screen"

            ratio = left_dist / right_dist
            if ratio > 3.5 or ratio < 0.25:
                return True, "Looking Off-Screen"
        else:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.1, 4)
            if len(faces) == 0:
                return True, "Candidate Absent / Face Not Detected"
            elif len(faces) > 1:
                return True, "Multiple Persons in Camera View"

    return False, ""


@app.websocket("/ws/proctor/{student_name}")
async def proctor_endpoint(websocket: WebSocket, student_name: str):
    await websocket.accept()
    active_connections.add(student_name)
    print(f"[{student_name}] Connected to AI Proctoring...")

    try:
        while True:
            data = await websocket.receive_text()
            encoded_data = data.split(',')[1] if ',' in data else data
            nparr = np.frombuffer(base64.b64decode(encoded_data), np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if frame is None:
                continue

            violation_triggered, message = await asyncio.to_thread(run_ai_proctoring, frame)

            if violation_triggered:
                if should_log_violation(student_name, message):
                    print(f"ALERT: {message} for {student_name}!")
                    await asyncio.to_thread(log_violation_to_db, student_name, message)

                await websocket.send_json({
                    "status": "VIOLATION",
                    "message": message
                })
            else:
                await websocket.send_json({"status": "OK"})

    except WebSocketDisconnect:
        active_connections.discard(student_name)
        violation_cooldowns.pop(student_name, None)
        print(f"[{student_name}] Disconnected.")
    except Exception as err:
        active_connections.discard(student_name)
        print(f"[{student_name}] WebSocket Error: {err}")


@app.get("/")
@app.get("/index.html")
async def serve_index():
    return FileResponse(os.path.join(BASE_PATH, "index.html"))


@app.get("/dashboard")
@app.get("/dashboard.html")
async def serve_dashboard():
    return FileResponse(os.path.join(BASE_PATH, "dashboard.html"))


@app.get("/styles.css")
async def serve_styles():
    return FileResponse(os.path.join(BASE_PATH, "styles.css"), media_type="text/css")


@app.get("/app.js")
async def serve_js():
    return FileResponse(os.path.join(BASE_PATH, "app.js"), media_type="application/javascript")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)