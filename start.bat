@echo off
echo Starting local server for PDF Editor...
echo ==========================================
echo Please open your browser and go to:
echo http://localhost:8000
echo ==========================================
python -m http.server 8000
pause
