@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  py -3 -m venv .venv
)
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if not exist ".env" (
  copy ".env.example" ".env"
  echo.
  echo IMPORTANT: Edit .env and set EXAM_ACCESS_PIN and FACULTY_PIN before use.
  notepad ".env"
)
python -m uvicorn server:app --host 0.0.0.0 --port 8000
