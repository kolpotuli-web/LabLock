@echo off
cd /d "%~dp0"
echo Starting LabLock AI Proctoring Server on http://localhost:8000 ...
python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
pause
