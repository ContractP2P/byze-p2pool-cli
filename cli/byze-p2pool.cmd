@echo off
setlocal
set "HERE=%~dp0"
node "%HERE%tools\ensure-native.js"
if errorlevel 1 exit /b %errorlevel%
node "%HERE%src\byze-p2pool.js" %*
