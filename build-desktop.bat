@echo off
setlocal
cd /d "%~dp0"
python -m pip install -r desktop\requirements.txt
if errorlevel 1 exit /b 1
call npm.cmd run build
if errorlevel 1 exit /b 1
python -m PyInstaller --noconfirm "Agent Monitor.spec"
if errorlevel 1 exit /b 1
copy /Y "dist\Agent Monitor.exe" "Agent Monitor.exe" >nul
if errorlevel 1 exit /b 1
echo Built "%~dp0Agent Monitor.exe"
