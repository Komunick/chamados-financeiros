' Inicia o servidor de chamados em segundo plano, sem janela visivel.
' Resolve o start-server.bat na MESMA pasta deste .vbs (sem caminho fixo).
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
bat = fso.BuildPath(pasta, "start-server.bat")
WshShell.Run Chr(34) & bat & Chr(34), 0, False
Set WshShell = Nothing
