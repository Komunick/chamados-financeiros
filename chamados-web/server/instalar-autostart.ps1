# Configura o servidor de Chamados Financeiros para subir sozinho no boot.
# Cria uma Tarefa Agendada (conta SYSTEM, gatilho "ao iniciar o Windows").
# Execute pelo INSTALAR-AUTOINICIO.bat (que pede elevacao). Requer admin.

$ErrorActionPreference = 'Stop'
# start-server.bat fica na pasta-mãe deste .ps1 (…\chamados-web\). Resolvemos
# pelo caminho do próprio script, sem depender de um local fixo no disco.
$bat = Join-Path (Split-Path $PSScriptRoot -Parent) 'start-server.bat'
if (-not (Test-Path $bat)) { throw "start-server.bat nao encontrado em: $bat" }

$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "{0}"' -f $bat)
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'ChamadosFinanceirosWeb' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Servidor de Chamados Financeiros (base compartilhada via ZeroTier). Sobe no boot.' -Force | Out-Null
Write-Host ''
Write-Host 'Auto-inicio configurado: o servidor subira sozinho a cada boot.' -ForegroundColor Green

# Reinicia agora pela tarefa, para que a instancia ativa seja a mesma do boot.
Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName 'ChamadosFinanceirosWeb'
Start-Sleep -Seconds 2
$c = Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue
if ($c) { Write-Host ("Servidor no ar (PID {0})." -f ($c.OwningProcess | Select-Object -First 1)) -ForegroundColor Green }
else { Write-Host 'Atencao: o servidor nao subiu; verifique server.log.' -ForegroundColor Yellow }
