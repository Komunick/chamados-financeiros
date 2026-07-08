' Inicia o servidor de chamados em segundo plano, sem janela visivel.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "C:\Users\brazil\opencode\chamados-web\start-server.bat" & Chr(34), 0, False
Set WshShell = Nothing
