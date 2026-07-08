$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = @'
<toast scenario="reminder" activationType="protocol" launch="http://10.13.47.131:8090/"><visual><binding template="ToastGeneric"><text>Novo chamado CH-000001 — Administrador</text><text>Solicitante: Administrador. Veículo: RTA-2B25 (VW Constellation 24.280). Condutor: Carlos Pereira. Valor total: R$ 2.000,00. Adiantamento (70%): R$ 1.400,00. Saldo: R$ 600,00.</text><text>Marque como visto no sistema para parar os avisos.</text></binding></visual><actions><action content="Abrir sistema" activationType="protocol" arguments="http://10.13.47.131:8090/"/><action content="Dispensar" activationType="system" arguments="dismiss"/></actions><audio src="ms-winsoundevent:Notification.Default"/></toast>
'@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification($doc)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
