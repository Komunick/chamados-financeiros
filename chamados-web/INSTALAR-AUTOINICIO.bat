@echo off
title Instalar auto-inicio - Chamados Financeiros
REM Pede elevacao (UAC) se ainda nao estiver como administrador, depois roda o .ps1
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\brazil\opencode\chamados-web\server\instalar-autostart.ps1"
echo.
echo Pronto. Pode fechar esta janela.
pause
