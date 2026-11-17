@echo off
setlocal
set "SH=%ProgramFiles%\Git\bin\sh.exe"
if not exist "%SH%" set "SH=%ProgramFiles(x86)%\Git\bin\sh.exe"
if not exist "%SH%" echo QM apply: Git for Windows not found 1>&2 & exit /b 4
cd /d "%~dp0"
"%SH%" apply.sh %*
exit /b %ERRORLEVEL%
