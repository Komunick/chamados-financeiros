@echo off
title Chamados Financeiros - Servidor (Node, porta 8090)
cd /d "C:\Users\brazil\opencode\chamados-web"
set PORT=8090
set HOST=0.0.0.0

:loop
echo [%date% %time%] Iniciando servidor Node na porta %PORT% >> server.log
"C:\Program Files\nodejs\node.exe" "C:\Users\brazil\opencode\chamados-web\server\server.js" >> server.log 2>&1
echo [%date% %time%] Servidor encerrou (codigo %errorlevel%); reiniciando em 5s... >> server.log
ping -n 6 127.0.0.1 >nul 2>&1
goto loop
