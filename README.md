# LabLock

LabLock is a local FastAPI examination terminal with a browser-based candidate workspace, webcam frame streaming, AI proctoring, and a faculty audit dashboard.

## Repository layout

The active application now lives at the repository root:

- `server.py` — FastAPI backend, SQLite session/audit handling and AI inference workers.
- `index.html`, `dashboard.html`, `styles.css`, `app.js` — candidate terminal and faculty console.
- `requirements.txt` — Python dependencies.
- `lablock_final/yolov8n.pt` — retained YOLO model weights.
- `lablock_final/lablock.db` — retained SQLite database, including existing audit records.

The old `lablock_final` directory is retained only for the existing model and database files during this migration. The duplicate application source files in that folder are no longer used.

## Run on Windows

1. Install Python 3.10 or 3.11 (recommended) and ensure the Python launcher `py` is available.
2. Copy `.env.example` to `.env` and set two separate secret values: `EXAM_ACCESS_PIN` and `FACULTY_PIN`.
3. Double-click `start_server.bat`.
4. Open [http://127.0.0.1:8000](http://127.0.0.1:8000) for the candidate terminal and [http://127.0.0.1:8000/dashboard](http://127.0.0.1:8000/dashboard) for the faculty console.

Manual setup:

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

## Runtime behavior

- Candidate authentication is checked by the backend; no PIN is accepted based only on client-side length checks.
- Faculty lockout release is also verified by the backend.
- Each inference worker owns its own YOLO and MediaPipe instances. This avoids unsafe concurrent access to shared model objects and removes the single global AI mutex bottleneck.
- AI work runs in a bounded thread pool. Set `LABLOCK_AI_WORKERS` to tune parallel model instances; increasing it increases RAM/VRAM usage.
- SQLite uses WAL, a busy timeout, indexed audit/session tables and short-lived connections.
- WebSocket frames are validated, size-limited, downscaled when needed and rate-limited. Active sockets must reference a valid candidate session.
- Browser WebSocket backpressure is checked before sending another frame; reconnect attempts are limited to one pending timer.
- The browser does not execute candidate code using `new Function`. A real isolated execution sandbox is required before enabling Run Evaluation.

## AI model and privacy

The YOLO model is kept in `lablock_final/yolov8n.pt`. MediaPipe FaceMesh is used when the installed MediaPipe build exposes the supported solution API; otherwise the backend falls back to OpenCV face detection. The fallback does not perform gaze estimation.

Frames are processed in memory and are not saved by this backend. Violation metadata is written to SQLite. Do not expose this development server directly to the public internet. Use HTTPS/WSS, authenticated faculty sessions, institutional access controls, a retention policy and a security review before production use.

## Health and troubleshooting

- `GET /health` reports database availability, AI warm-up status, worker count and active terminals.
- If AI is unavailable, verify the YOLO weights path and the installed PyTorch/Ultralytics runtime.
- If the browser cannot access the camera, use localhost or HTTPS and grant camera permission.
- Use one backend process for the SQLite database. Multiple Uvicorn workers would each maintain their own in-memory cooldown map and model pool.


## Validation

GitHub Actions compiles the Python backend, checks the browser JavaScript syntax, verifies required assets, and runs API integration tests for candidate authentication, session lifecycle, faculty authorization and audit access. The CI runner deliberately does not download or execute the full YOLO/MediaPipe model stack. Validate real-time detection, throughput, camera permissions and memory use on the target lab computers before an examination.
