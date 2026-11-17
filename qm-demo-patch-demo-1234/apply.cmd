@echo off
setlocal
set "SH="
set "DOUBLE="
set "RC=0"
echo %CMDCMDLINE% | find /i "/c" >nul && set "DOUBLE=1"
for /f "delims=" %%G in ('where git 2^>nul') do if not defined SH call :probe "%%~dpG"
if not defined SH call :probe "%ProgramFiles%\Git\cmd\"
if not defined SH call :probe "%ProgramFiles(x86)%\Git\cmd\"
if not defined SH call :probe "%LocalAppData%\Programs\Git\cmd\"
if not defined SH echo QM apply: Git for Windows was not found. Install it from https://git-scm.com/download/win and run this file again. 1>&2 & set "RC=4" & goto done
cd /d "%~dp0"
"%SH%" apply.sh %*
set "RC=%ERRORLEVEL%"
:done
if defined DOUBLE pause
exit /b %RC%
:probe
if exist "%~1..\usr\bin\sh.exe" set "SH=%~1..\usr\bin\sh.exe"
if not defined SH if exist "%~1..\bin\sh.exe" set "SH=%~1..\bin\sh.exe"
exit /b 0
