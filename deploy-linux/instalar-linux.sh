#!/usr/bin/env bash
# Brazil Transports — Chamados Financeiros
# Instala o sistema como serviço (systemd) no Linux (testado no Linux Mint).
#
# Uso, dentro da pasta do repositório clonado:
#   sudo bash deploy-linux/instalar-linux.sh
#
# Porta padrão: 8090 (a 3100 já é usada por outro sistema na VM — evitada).
# Para trocar: sudo PORTA=8091 bash deploy-linux/instalar-linux.sh
set -euo pipefail

PORTA="${PORTA:-8090}"
USUARIO="${SUDO_USER:-$USER}"
DIR_REPO="$(cd "$(dirname "$0")/.." && pwd)"
SERVIDOR="$DIR_REPO/chamados-web/server/server.js"

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo bash deploy-linux/instalar-linux.sh"
  exit 1
fi
if [ ! -f "$SERVIDOR" ]; then
  echo "server.js nao encontrado em $SERVIDOR — rode de dentro do repositorio clonado."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nao encontrado. Instale primeiro:"
  echo "  sudo apt update && sudo apt install -y nodejs"
  exit 1
fi
if [ "$PORTA" = "3100" ]; then
  echo "A porta 3100 ja esta em uso por outro sistema. Escolha outra (padrao: 8090)."
  exit 1
fi
if ss -tln 2>/dev/null | grep -q ":$PORTA "; then
  echo "Atencao: a porta $PORTA ja parece estar em uso nesta maquina."
  echo "Escolha outra com: sudo PORTA=8091 bash deploy-linux/instalar-linux.sh"
  exit 1
fi

cat > /etc/systemd/system/chamados.service <<UNIT
[Unit]
Description=Brazil Transports - Chamados Financeiros (porta $PORTA)
After=network.target

[Service]
Type=simple
User=$USUARIO
WorkingDirectory=$DIR_REPO/chamados-web
Environment=PORT=$PORTA
Environment=HOST=0.0.0.0
ExecStart=$(command -v node) $SERVIDOR
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now chamados.service

# Libera a porta no firewall (se o ufw estiver ativo).
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORTA"/tcp >/dev/null || true
  echo "Firewall (ufw): porta $PORTA/tcp liberada."
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "Servico 'chamados' instalado e rodando."
echo "  Acesso na rede local:  http://${IP:-192.168.1.253}:$PORTA"
echo "  Status:                systemctl status chamados"
echo "  Logs:                  journalctl -u chamados -f"
echo "  Dados:                 $DIR_REPO/chamados-data/"
echo ""
echo "Primeiro acesso: admin / admin123 (troque a senha!)."
