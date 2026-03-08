# agentdraw

Connect your AI agents to the cloud. One command to link, tunnel, and manage your [OpenClaw](https://openclaw.ai) gateway through [AgentDraw](https://agentdraw.io).

## Quick Start

```bash
# Link your gateway (interactive — shows QR code)
npx agentdraw link

# Start the tunnel
npx agentdraw connect --token <your-token> --upstream http://localhost:18789
```

## Commands

### `agentdraw link`
Link this machine to your AgentDraw account. Displays a QR code + word-code (e.g. `WARM-FISH`) — scan or type the code on the web to authorize.

### `agentdraw link <token>`
Redeem a link token for headless/CI setups.

### `agentdraw connect`
Start the gateway tunnel. Forwards requests from the AgentDraw relay to your local OpenClaw instance.

```bash
agentdraw connect \
  --token gw_live_xxx \
  --upstream http://localhost:18789 \
  --name "My Machine"
```

### `agentdraw status`
Show current link status and config.

### `agentdraw whoami`
Show linked account info.

### `agentdraw unlink`
Remove stored credentials and unlink this gateway.

### `agentdraw pair`
Generate a pairing code for the AgentDraw mobile app.

### `agentdraw devices`
List connected app devices.

## Configuration

Config is stored at `~/.agentdraw/config.json` after linking.

## Environment Variables

- `AGENTDRAW_DEFAULT_RELAY` — Override the default relay URL

## Requirements

- Node.js 18+
- An [OpenClaw](https://openclaw.ai) gateway running locally

## License

MIT
