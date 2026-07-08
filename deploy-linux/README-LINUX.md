# Rodando na VM Linux (Linux Mint, IP fixo 192.168.1.253)

O sistema é Node puro (sem `npm install`), então rodar no Linux é só clonar e
instalar o serviço. A porta padrão é **8090** — a **3100 já é usada por outro
sistema na VM e é bloqueada pelo instalador**.

## Instalação (uma vez, na VM)

```bash
# 1. Node.js (se ainda não tiver)
sudo apt update && sudo apt install -y nodejs git

# 2. Clonar o repositório (branch dev = versão atual)
git clone -b dev https://github.com/Komunick/chamados-financeiros.git
cd chamados-financeiros

# 3. Instalar como serviço (sobe sozinho no boot e reinicia se cair)
sudo bash deploy-linux/instalar-linux.sh
```

Pronto: **http://192.168.1.253:8090** para todo mundo da rede local.
Primeiro acesso: `admin / admin123` (troque a senha).

- Status: `systemctl status chamados` · Logs: `journalctl -u chamados -f`
- Dados ficam em `chamados-financeiros/chamados-data/` (fora do controle do git).
- Outra porta: `sudo PORTA=8091 bash deploy-linux/instalar-linux.sh`
- Atualizar o sistema: `git pull && sudo systemctl restart chamados`

## Migrando os dados do servidor Windows (opcional)

Se a VM for virar o servidor oficial, copie a pasta `chamados-data\`
(chamados.json + anexos + backups) do Windows para dentro da pasta
`chamados-financeiros/` na VM **com o serviço parado**
(`sudo systemctl stop chamados`, copie, `sudo systemctl start chamados`).
Mantenha só UM servidor oficial — dois servidores têm bancos separados.

## Acesso de fora da rede (internet)

Três caminhos, do mais recomendado ao menos:

1. **VPN — ZeroTier ou Tailscale (recomendado; já é o padrão do projeto).**
   Instale na VM e no dispositivo de quem vai acessar; os dois entram na mesma
   rede virtual e a pessoa acessa como se estivesse na rede local, sem expor
   nada na internet. Na VM:
   ```bash
   # Tailscale
   curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
   # ou ZeroTier
   curl -s https://install.zerotier.com | sudo bash && sudo zerotier-cli join <ID-DA-REDE>
   ```
   A pessoa de fora instala o mesmo app, entra na rede e acessa
   `http://<ip-da-vm-na-vpn>:8090`. É o caminho mais seguro porque o sistema
   usa HTTP (senhas em texto na rede) — dentro da VPN o tráfego vai cifrado.

2. **Túnel com HTTPS (Cloudflare Tunnel, sem mexer no roteador).**
   Dá uma URL pública `https://...` que aponta para a VM, com criptografia,
   sem abrir porta no roteador. Bom para dar acesso a alguém sem instalar
   VPN. Requer conta na Cloudflare (grátis) e o `cloudflared` na VM.

3. **Redirecionamento de porta no roteador (não recomendado sem HTTPS).**
   No roteador, encaminhe uma porta externa (ex.: 8090) para
   `192.168.1.253:8090` e passe o IP público (`curl ifconfig.me`) para as
   pessoas. Problemas: se a operadora usa CGNAT não funciona; o IP muda; e o
   sistema ficaria exposto na internet **sem criptografia** — qualquer um
   pode tentar a tela de login e as senhas trafegam em claro. Se for por esse
   caminho, coloque um proxy com HTTPS na frente (Caddy/Nginx + certificado).
