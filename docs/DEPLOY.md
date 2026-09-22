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

## 1. Servidor

Ubuntu LTS. Firewall do provedor liberando só SSH, mais o `ufw` no servidor.

```bash
# usuário comum com sudo (troque "voce")
sudo adduser voce && sudo usermod -aG sudo voce
# copie sua chave pública para ~voce/.ssh/authorized_keys e TESTE o login por chave
# numa segunda janela ANTES de desativar a senha (senão você se tranca fora)

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
- **`DASHBOARD_HOST`** fica no padrão (`127.0.0.1`). Não defina.

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
journalctl -u polybot -f          # logs; o token aleatório só é impresso se DASHBOARD_TOKEN não estiver definido
```

## 5. Acessar a dashboard: só por túnel SSH

```bash
ssh -L 3001:127.0.0.1:3001 voce@SEU_VPS
# depois abra http://localhost:3001/?token=SEU_TOKEN
```

**Nunca abra a porta 3001 na internet.** Ela é protegida só por um token na URL.

## 6. Ordem de subida

1. **Dry-run por 24 a 48 h** (`DRY_RUN=true`). Confira o relógio sincronizado, a latência até a Polymarket e, nos
   logs, o resumo do copy engine (`📊 Copy engine …`) e as linhas `[SIMULATION] Settled …`.
2. **Financie a carteira dedicada**: primeiro um teste de $1 a $2 para confirmar endereço e rede (Polygon), depois
   o resto em **USDC.e** (o bot não usa USDC nativo) mais cerca de 1 MATIC para gás.
3. **Vá para LIVE**: `DRY_RUN=false` em `/etc/polybot/polybot.env` e `sudo systemctl restart polybot`.
   Na primeira subida em LIVE o bot **envia aprovações on-chain sozinho** (`onchain.autoApprove=true`,
   aprovação ilimitada aos contratos da Polymarket). Acompanhe `✅ All approvals ready` e `PnL baseline anchored`.
4. **Desligue o Direct Trading** na dashboard assim que subir (ele vem `enabled: true` fixo no código).
5. **Vigie as primeiras cópias**: confira cada uma na Polygonscan e mantenha o Emergency Stop à mão pelo túnel.

## 7. Operação

- **Backup** de `/opt/polybot/data` (histórico de sessões e `paper-positions.json`) para um destino criptografado.
  A chave privada é guardada **à parte**, num gerenciador de senhas, nunca junto dos backups do servidor.
- **Alerta** quando o serviço cair (por exemplo com `OnFailure=` chamando uma unit que envia e-mail ou Telegram).
- **Atualizar**: `git pull`, `npm ci --ignore-scripts`, `(cd dashboard && npm ci --ignore-scripts && npm run build)`,
  `sudo systemctl restart polybot`.
- **Parar**: `sudo systemctl stop polybot`.
- **Se suspeitar de invasão**: pare o serviço, retire os fundos, revogue as aprovações (revoke.cash) e gere outra chave.

## Cuidados específicos deste bot

- **Reinício zera os contadores de risco.** Pelo código, a perda diária/mensal e a sequência de perdas ficam só em
  memória. Um reinício automático as zera e o bot pode voltar a operar depois de perdas. Por isso o
  `StartLimitBurst` baixo; em LIVE considere `Restart=no` com alerta.
- **A chave é legível por quem invadir o servidor** (memória do processo). Só o saldo mínimo limita o dano.
- **`autoApprove` não tem variável de ambiente** para desligar hoje.
- **Nada disso substitui resultados**: o bot nunca foi validado em LIVE.
