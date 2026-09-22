# Deploy seguro em um VPS

> **Status: plano, ainda não executado.** Escrito em 2026-09-21. Os comandos e a unit do systemd são um ponto de partida
> e **não foram testados num servidor real** (o bot foi desenvolvido e testado em WSL2). Revise cada passo antes de usar.

O maior risco de rodar este bot num VPS é a **chave privada num disco que você não controla**. O segundo é a
**dashboard exposta**: ela tem botões de Emergency Stop, Panic Sell e de trocar para LIVE. O plano abaixo existe
para limitar esses dois riscos.

## 0. Antes de tocar no servidor

- **Repositório privado seu.** Faça commit das suas mudanças e suba para um repositório **privado** seu. Nunca
  suba `.env`, chaves ou tokens.
- **Carteira dedicada com saldo mínimo**, que nunca teve outros fundos. Gere a chave no seu terminal, sem passar
  por chats ou ferramentas de terceiros.
- **Região legal.** Escolha um VPS numa região onde você pode negociar na Polymarket. Não use VPS ou VPN para
  contornar restrições: os termos da Polymarket proíbem isso, e uma conta bloqueada pode prender o saldo.
- **Resultados de dry-run.** Não vá para LIVE antes de ver resultados de dry-run com a liquidação paper
  (tabela "Paper Positions" na dashboard).
- **Conta do provedor protegida, não só o servidor.** Ative 2FA na conta do provedor (DigitalOcean etc.) — quem
  entra nela abre o console de recovery do droplet sem precisar de chave SSH nenhuma, e todo o hardening de SSH
  abaixo fica irrelevante. Desative o backup automático do droplet (ou, se mantiver, criptografe o destino): um
  snapshot de disco inteiro guarda `/etc/polybot/polybot.env` — com a chave privada — em texto puro. Configure
  também o Cloud Firewall do provedor (camada de rede, fora do droplet) além do `ufw` do passo 1.

## 1. Servidor

Ubuntu LTS. Firewall do provedor liberando só SSH, mais o `ufw` no servidor.

```bash
# usuário comum com sudo (troque "voce")
sudo adduser voce && sudo usermod -aG sudo voce
sudo mkdir -p ~voce/.ssh && sudo chmod 700 ~voce/.ssh
# copie sua chave pública para ~voce/.ssh/authorized_keys (ex.: cole o conteúdo do
# .pub que já está em /root/.ssh/authorized_keys, se foi a chave usada na criação do
# droplet — NÃO use `mv`: ele preserva o dono root, e o sshd rejeita silenciosamente
# um authorized_keys que não pertença ao usuário)
sudo chown -R voce:voce ~voce/.ssh
sudo chmod 600 ~voce/.ssh/authorized_keys
# TESTE o login por chave numa segunda janela ANTES de desativar a senha
# (senão você se tranca fora). Se der "Permission denied (publickey)" mesmo com a
# chave certa, o suspeito nº 1 é dono/permissão: `ls -la ~voce/.ssh` deve mostrar
# voce:voce, não root:root.

# /etc/ssh/sshd_config.d/99-hardening.conf
#   PermitRootLogin no
#   PasswordAuthentication no
sudo systemctl reload ssh

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit OpenSSH            # se puder, restrinja ao seu IP: sudo ufw allow from SEU.IP to any port 22
sudo ufw enable

sudo apt install -y fail2ban unattended-upgrades chrony
timedatectl                       # confirme: "System clock synchronized: yes"
```

O relógio importa: a guarda que descarta trades defasados (mais de 5 s) compara o horário do trade com o do servidor.

## 2. Node e código

Instale o **Node no sistema** (NodeSource ou pacote da distro), **não** via `nvm` na home: a unit abaixo usa
`ProtectHome=yes` e não enxergaria o `nvm`. Use a mesma versão principal em que você testou (`node -v`), ou
confirme que `npm test` passa na versão do servidor.

```bash
sudo mkdir -p /opt/polybot && sudo chown voce: /opt/polybot
git clone git@github.com:SEU_USUARIO/SEU_REPO_PRIVADO.git /opt/polybot    # com uma deploy key SOMENTE LEITURA

cd /opt/polybot
npm ci --ignore-scripts           # completo: o bot roda via tsx, que é devDependency (NÃO use --omit=dev)
(cd dashboard && npm ci --ignore-scripts && npm run build)
npm test

# o serviço roda como um usuário sem login, que só escreve em data/
sudo adduser --system --group --no-create-home --shell /usr/sbin/nologin polybot
sudo install -d -o polybot -g polybot -m 700 /opt/polybot/data
```

O código fica de propriedade do seu usuário (somente leitura para o `polybot`): se o processo for comprometido, ele
não consegue reescrever o próprio código.

> O `tsc` não compila `bot-with-dashboard.ts` (o `tsconfig.json` só inclui `src/`), por isso o bot roda com `tsx`.

## 3. Segredos

As variáveis ficam num arquivo **fora do repositório**, legível só pelo root, carregado pelo systemd:

```bash
sudo install -d -m 755 /etc/polybot
sudo install -m 600 -o root -g root /dev/null /etc/polybot/polybot.env
sudoedit /etc/polybot/polybot.env
```

Modelo (placeholders; preencha no servidor):

```
POLYMARKET_PRIVATE_KEY=0x...
DRY_RUN=true
CAPITAL_USD=20
SMARTMONEY_ENABLED=true
ARBITRAGE_ENABLED=false
DIPARB_ENABLED=false
TREND_ANALYSIS_ENABLED=false
CUSTOM_WALLETS=0x...,0x...
POLYGON_RPC_URL=https://...
DASHBOARD_TOKEN=<saída de: openssl rand -hex 24>
```

Regras:

- **Sem comentário na mesma linha de um valor.** O `dotenv` aceita `DRY_RUN=true # nota`, mas o
  `EnvironmentFile` do systemd **não**: ele leria `true # nota` e, por exemplo, `SMARTMONEY_ENABLED=true # nota`
  deixaria de valer `'true'`. Comentários só em linhas próprias.
- **Cada variável uma única vez.** O `dotenv` usa a última ocorrência quando há duplicatas, o que confunde na hora
  de trocar `DRY_RUN`.
- **`CAPITAL_USD` igual ao saldo real.** Os limites de risco são frações do `CAPITAL_USD`, não do saldo.
- **`POLYGON_RPC_URL` seu** (Alchemy, Infura, etc.): o RPC público é instável para operar.
- **`DASHBOARD_HOST`**: deixe no padrão (`127.0.0.1`, não defina) se for usar só o túnel SSH (seção 5.1). Se for
  usar WireGuard para vários dispositivos (seção 5.2), defina `DASHBOARD_HOST=10.8.0.1` — só depois de subir a VPN.

## 4. Serviço systemd

`/etc/systemd/system/polybot.service`:

```ini
[Unit]
Description=Polymarket bot
After=network-online.target
Wants=network-online.target
# Estas duas linhas ficam em [Unit], não em [Service].
StartLimitIntervalSec=600
StartLimitBurst=3

[Service]
Type=simple
User=polybot
Group=polybot
WorkingDirectory=/opt/polybot
EnvironmentFile=/etc/polybot/polybot.env
ExecStart=/opt/polybot/node_modules/.bin/tsx bot-with-dashboard.ts
Restart=on-failure
RestartSec=30
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
ReadWritePaths=/opt/polybot/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now polybot
sudo journalctl -u polybot -f     # logs; o token aleatório só é impresso se DASHBOARD_TOKEN não estiver definido
```

> **`journalctl -u polybot` sem `sudo` não mostra nada** (só um aviso sobre os grupos `adm`/`systemd-journal`),
> mesmo com o serviço rodando — porque o `polybot` roda como um usuário diferente do seu login (`polymarket`
> etc.), e o journal só mostra logs de outro usuário pra quem é root ou está num desses grupos. Sempre com
> `sudo`. Pra confirmar o estado do serviço antes de olhar logs: `sudo systemctl status polybot`.

## 5. Acessar a dashboard: WireGuard (vários dispositivos) ou túnel SSH (um só)

**Nunca abra a porta 3001 na internet diretamente.** Ela é protegida só por um token na URL — o acesso remoto
tem que passar por um dos dois caminhos abaixo.

### 5.1 Um dispositivo, uso ocasional: túnel SSH

Não precisa de nenhum setup a mais. Funciona bem em Windows/macOS; no celular precisa de um app SSH (ex.
Termius) e o túnel cai quando o app vai para o background.

```bash
ssh -L 3001:127.0.0.1:3001 voce@SEU_VPS
# depois abra http://localhost:3001/?token=SEU_TOKEN
```

### 5.2 Vários dispositivos pessoais (laptops + celular): WireGuard

Diferente de um WireGuard "de casa" (que roteia para uma rede local inteira), aqui **o próprio droplet é o
destino** — não precisa de `iptables FORWARD`, `MASQUERADE` nem `ip_forward`. Cada dispositivo entra na VPN e
fala direto com o droplet.

**Instalar e gerar as chaves** (uma vez, no servidor — uma chave por dispositivo, nunca reaproveite):

```bash
sudo apt install -y wireguard qrencode
sudo mkdir -p /etc/wireguard/clients && sudo chmod 700 /etc/wireguard /etc/wireguard/clients
umask 077

wg genkey | sudo tee /etc/wireguard/server_private.key | wg pubkey | sudo tee /etc/wireguard/server_public.key

for peer in windows macos phone; do
  wg genkey | sudo tee /etc/wireguard/clients/$peer.key | wg pubkey | sudo tee /etc/wireguard/clients/$peer.pub
done
```

> Gerar as chaves dos clientes no servidor é conveniente (monta os 3 configs de uma vez), mas a chave privada de
> cada dispositivo passa por aqui antes de chegar a ele. Depois de distribuir os configs (5.2.3), apague os
> `.key` dos clientes do servidor: `sudo shred -u /etc/wireguard/clients/*.key`. O servidor só precisa guardar as
> chaves **públicas** dos clientes — nunca as privadas.

**5.2.1 Config do servidor** (`/etc/wireguard/wg0.conf`):

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <conteúdo de server_private.key>

[Peer]
# windows
PublicKey = <conteúdo de clients/windows.pub>
AllowedIPs = 10.8.0.2/32

[Peer]
# macos
PublicKey = <conteúdo de clients/macos.pub>
AllowedIPs = 10.8.0.3/32

[Peer]
# phone
PublicKey = <conteúdo de clients/phone.pub>
AllowedIPs = 10.8.0.4/32
```

```bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0
```

**Firewall — abrir só a porta da VPN, nas duas camadas** (droplet + provedor):

```bash
sudo ufw allow 51820/udp
```

No painel do provedor, no Cloud Firewall do droplet: liberar **UDP 51820** de entrada. Os 3 dispositivos saem de
redes/IPs variáveis, então não dá pra restringir por IP de origem aqui — a segurança vem da chave WireGuard, não
do IP.

**5.2.2 Dashboard passa a ouvir na VPN, não em loopback:**

Em `/etc/polybot/polybot.env`:

```
DASHBOARD_HOST=10.8.0.1
```

```bash
sudo systemctl restart polybot
```

Isso desativa a checagem anti-DNS-rebinding do `server.ts` (só se aplica a bind em loopback — ver o comentário em
`src/dashboard/server.ts`); a partir daqui a proteção é **WireGuard (só quem tem a chave entra em 10.8.0.0/24) +
token da dashboard**. Restrinja a porta 3001 à interface da VPN, e confirme que não existe regra abrindo-a de
forma geral:

```bash
sudo ufw allow in on wg0 to any port 3001
sudo ufw status numbered | grep 3001   # não deve sobrar nenhuma regra "3001" sem "on wg0"
```

**5.2.3 Configs de cliente**

`AllowedIPs` aponta só para o IP da VPN do droplet (10.8.0.1/32) — split tunnel: só o tráfego para o dashboard
passa pela VPN, o resto (navegação normal) sai direto. Importa principalmente no celular.

```ini
# windows.conf (Address = 10.8.0.2/32) / macos.conf (Address = 10.8.0.3/32) / phone.conf (Address = 10.8.0.4/32)
[Interface]
PrivateKey = <conteúdo da .key do próprio dispositivo>
Address = 10.8.0.X/32

[Peer]
PublicKey = <conteúdo de server_public.key>
Endpoint = SEU_IP_DO_DROPLET:51820
AllowedIPs = 10.8.0.1/32
PersistentKeepalive = 25
```

- **Windows**: app oficial WireGuard (Microsoft Store ou wireguard.com/install) → importar `windows.conf`.
- **macOS**: app oficial na Mac App Store → importar `macos.conf`.
- **Celular**: converta `phone.conf` em QR code e escaneie direto no app WireGuard (iOS/Android têm "Scan from
  QR code"):

```bash
qrencode -t ansiutf8 < phone.conf
```

**5.2.4 Verificação**

```bash
sudo wg show     # "latest handshake" recente para cada peer, depois de conectar
```

Com a VPN ligada em qualquer dispositivo: `http://10.8.0.1:3001/?token=SEU_TOKEN` — mesmo endereço nos 3, sem
abrir túnel manualmente a cada vez.

## 6. Ordem de subida

1. **Dry-run por 24 a 48 h** (`DRY_RUN=true`). Confira o relógio sincronizado, a latência até a Polymarket e, nos
   logs, o resumo do copy engine (`📊 Copy engine …`) e as linhas `[SIMULATION] Settled …`.
2. **Financie a carteira dedicada**: primeiro um teste de $1 a $2 para confirmar endereço e rede (Polygon), depois
   o resto em **USDC.e** (o bot não usa USDC nativo) mais cerca de 1 MATIC para gás.
3. **Vá para LIVE**: `DRY_RUN=false` em `/etc/polybot/polybot.env` e `sudo systemctl restart polybot`.
   Na primeira subida em LIVE o bot **envia aprovações on-chain sozinho** (`onchain.autoApprove=true`,
   aprovação ilimitada aos contratos da Polymarket). Acompanhe `✅ All approvals ready` e `PnL baseline anchored`.
4. ~~Desligue o Direct Trading na dashboard assim que subir~~ — conferido em 2026-09-22: em `bot-with-dashboard.ts`
   (o arquivo que este plano roda) `directTrading.enabled` está fixo em `false` e nada no código o liga em
   runtime, nem o toggle da dashboard. A afirmação anterior aqui vinha de `bot-config.ts`, que tem `enabled:
   true` — arquivo diferente do que a unit systemd executa. `TREND_ANALYSIS_ENABLED` só liga a coleta de
   K-line da Binance (sinal de tendência), não o Direct Trading em si.
5. **Vigie as primeiras cópias**: confira cada uma na Polygonscan e mantenha o Emergency Stop à mão pelo túnel.

## 7. Operação

- **Backup** de `/opt/polybot/data` (histórico de sessões e `paper-positions.json`) para um destino criptografado.
  A chave privada é guardada **à parte**, num gerenciador de senhas, nunca junto dos backups do servidor.
- **Alerta** quando o serviço cair (por exemplo com `OnFailure=` chamando uma unit que envia e-mail ou Telegram).
- **Atualizar**: `git pull`, `npm ci --ignore-scripts`, `(cd dashboard && npm ci --ignore-scripts && npm run build)`,
  `sudo systemctl restart polybot`.
- **Parar**: `sudo systemctl stop polybot`.
- **Se suspeitar de invasão**: pare o serviço, retire os fundos (`PRIVATE_KEY=0x... npx tsx scripts/wallet/withdraw.ts usdce SEU_ENDERECO_SEGURO all`,
  depois o mesmo com `matic`), revogue as aprovações (revoke.cash) e gere outra chave.
- **Sacar fundos em qualquer outra situação** (não só invasão): mesmo comando acima, rodado no servidor —
  a chave nunca vai como argumento de linha de comando (ficaria no histórico do shell), só via `PRIVATE_KEY`.

## 8. Plano de escala de capital: $100 → $1000

> Os limiares abaixo vêm de uma fórmula real do código, não de "quando parecer confortável": `canOpenPosition`
> em `bot-with-dashboard.ts` calcula `perTradeCap = CAPITAL_USD × maxPerTradePct` (2%, fixo no código) e
> bloqueia qualquer trade — de qualquer estratégia — acima desse teto. Cada estratégia tem seu próprio valor
> mínimo de trade, então o capital necessário pra ela sair do papel é diferente:

| Estratégia | Mínimo de trade | Capital onde o teto de 2% empata | Capital com margem confortável (~2x) |
|---|---|---|---|
| Smart Money | $1 (mínimo Polymarket) | $50 | **$100** |
| DipArb | $1,50 (`minTradeValueUSD`) | $75 | **$150** |
| Arbitrage | $20 (`minTradeSize`) | $1000 | **$1200–1500** |

Em exatamente $1000 o teto do Arbitrage EMPATA com o mínimo — sujeito a ficar de fora por arredondamento ou
o preço do momento. Por isso o estágio 4 abaixo aponta pra $1200-1500, não $1000 seco.

**Alternativa mais rápida que acumular capital**: ajustar o código (reduzir `arbitrage.minTradeSize` de $20,
ou dar ao Arbitrage um `maxPerTradePct` próprio maior) chega ao mesmo resultado sem esperar juntar $1000+.
Não fizemos isso aqui porque o caminho escolhido foi escalar o capital — mas é uma opção se quiser chegar lá
mais rápido.

### Estágio 1 — $100, DRY_RUN, só Smart Money (ponto de partida)
- `.env`: `CAPITAL_USD=100`, `SMARTMONEY_ENABLED=true`, `ARBITRAGE_ENABLED=false`, `DIPARB_ENABLED=false`,
  `TREND_ANALYSIS_ENABLED=false`, `DRY_RUN=true`.
- **Critério de saída** (evidência, não prazo fixo):
  - Cópias reais aparecendo na tabela "Paper Positions" (não zero).
  - Pelo menos UMA liquidação (`[SIMULATION] Settled …` no log) contra um mercado que resolveu de verdade.
  - Resumo do copy engine (`📊 Copy engine …`) sem taxa de skip anormal (`quote_guard`/`risk_guard` dominando).
  - 48h corridas sem erro inesperado nos logs.

### Estágio 2 — ainda $100, LIVE, só Smart Money
- Só depois do Estágio 1 confirmado. `DRY_RUN=false`, mesmo capital pequeno — aqui o objetivo é validar
  execução REAL (fees, confirmação on-chain, aprovações), não ainda medir se a estratégia é lucrativa.
- Na primeira subida em LIVE, confirme `✅ All approvals ready` e `PnL baseline anchored` no log.
- Vigie as primeiras cópias na Polygonscan, Emergency Stop à mão (seção 6, já cobria isso).

### Estágio 3 — $150+, LIVE, Smart Money + DipArb
- Só suba `CAPITAL_USD` quando esse saldo estiver de fato na carteira (regra da seção 3).
- Ligue `DIPARB_ENABLED=true`.
- Critério de saída específico do DipArb: pelo menos um ciclo Leg1→Leg2 completo sem o stop-loss de 20%
  disparar por erro de hedge (não por movimento normal de mercado).

### Estágio 4 — $1200–1500, LIVE, tudo junto (inclui Arbitrage)
- Ligue `ARBITRAGE_ENABLED=true` só aqui.
- Confirme no log que o Arbitrage está de fato abrindo posições (não só escaneando) — se `Position blocked:
  ... exceeds per-trade cap` aparecer, o capital ainda não está alto o suficiente.

### Regra em toda transição de estágio
- `CAPITAL_USD` no `.env` = saldo real na carteira, sempre (nunca declare mais do que tem — os limites de
  risco perdem sentido).
- Teste qualquer estratégia nova em DRY_RUN por algumas horas antes de ir para LIVE, mesmo já tendo rodado
  LIVE com outra estratégia antes.
- `sudo systemctl restart polybot` depois de qualquer mudança no `.env`.

## Cuidados específicos deste bot

- **Reinício zera os contadores de risco.** Pelo código, a perda diária/mensal e a sequência de perdas ficam só em
  memória. Um reinício automático as zera e o bot pode voltar a operar depois de perdas. Por isso o
  `StartLimitBurst` baixo; em LIVE considere `Restart=no` com alerta.
- **A chave é legível por quem invadir o servidor** (memória do processo). Só o saldo mínimo limita o dano.
- **`autoApprove` não tem variável de ambiente** para desligar hoje.
- **Nada disso substitui resultados**: o bot nunca foi validado em LIVE.
