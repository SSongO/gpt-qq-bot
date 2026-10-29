@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
rem Newer Node versions use configured proxy variables when this startup option is enabled.
set "NODE_USE_ENV_PROXY=1"
set "BOT_NODE="
if exist "%~dp0runtime\node.exe" set "BOT_NODE=%~dp0runtime\node.exe"
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined BOT_NODE set "BOT_NODE=%%N"
if not defined BOT_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "BOT_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined BOT_NODE (
  echo Node.js 22.13+ is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
set "BOT_PROXY_FLAG="
"%BOT_NODE%" --help | findstr /c:"--use-env-proxy" >nul
if not errorlevel 1 set "BOT_PROXY_FLAG=--use-env-proxy"
"%BOT_NODE%" %BOT_PROXY_FLAG% --env-file-if-exists=.env src\main.js
pause
