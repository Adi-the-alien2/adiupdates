@echo off
title AdiUpdates Local App
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install Node.js from https://nodejs.org then run this file again.
  pause
  exit /b 1
)

echo Starting AdiUpdates...
start "" http://localhost:3000
node server.js
