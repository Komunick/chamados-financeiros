@echo off
rem Importa as placas (FROTA CERTADOC.xlsx + PROGRAMACAO BRAZIL TRANSPORTS.xlsx,
rem aba VEICULOS/CARRETAS) e os motoristas (CSV da programacao) para o cadastro
rem usado pelo autocompletar do "Novo chamado".
rem Rode de novo sempre que a frota ou a lista de motoristas mudar.
cd /d "%~dp0"
uv run --with openpyxl python importar-cadastro.py %*
if errorlevel 1 (
  echo.
  echo Falhou. Confira os caminhos dos arquivos no importar-cadastro.py
  echo ou passe --frota / --motoristas apontando para os arquivos certos.
)
pause
