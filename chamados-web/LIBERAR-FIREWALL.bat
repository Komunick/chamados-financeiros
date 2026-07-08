@echo off
title Liberar firewall - Chamados Financeiros (porta 8090)
REM Libera a porta 8090 para ZeroTier e Tailscale.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="Chamados Financeiros 8090" >nul 2>&1
netsh advfirewall firewall add rule name="Chamados Financeiros 8090" dir=in action=allow protocol=TCP localport=8090 remoteip=10.13.47.0/24,10.71.171.0/24,100.64.0.0/10 profile=any
echo.
echo Porta 8090 liberada:
echo   ZeroTier: 10.13.47.0/24, 10.71.171.0/24
echo   Tailscale: 100.64.0.0/10
pause
