#!/usr/bin/env node

import { Command } from 'commander';
import { GatewayClient } from './client.js';

const program = new Command();

program
  .name('openclaw-relay')
  .description('OpenClaw Relay Gateway CLI')
  .version('0.1.0');

program
  .command('connect')
  .description('Connect gateway to relay server')
  .requiredOption('--token <token>', 'Gateway token (gw_live_xxx)')
  .requiredOption('--upstream <url>', 'Local HTTP server to tunnel to')
  .option('--relay <url>', 'Relay WebSocket URL', 'ws://localhost:8080/v1/tunnel')
  .option('--name <name>', 'Gateway display name')
  .action(async (opts) => {
    const client = new GatewayClient({
      relayUrl: opts.relay,
      token: opts.token,
      upstream: opts.upstream,
      gatewayName: opts.name,
    });

    client.on('connected', ({ gatewayId }) => {
      console.log(`\n  Connected to relay as gateway: ${gatewayId}`);
      console.log(`  Forwarding to: ${opts.upstream}`);
      console.log(`  Press Ctrl+C to disconnect.\n`);
    });

    client.on('disconnected', ({ reason }) => {
      console.log(`  Disconnected: ${reason}`);
    });

    client.on('request', ({ method, path }) => {
      console.log(`  ${method} ${path}`);
    });

    client.on('error', ({ error }) => {
      console.error(`  Error: ${error.message}`);
    });

    process.on('SIGINT', async () => {
      console.log('\n  Disconnecting...');
      await client.disconnect();
      process.exit(0);
    });

    try {
      await client.connect();
    } catch (err) {
      console.error(
        `Failed to connect: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program
  .command('pair')
  .description('Generate a pairing code for mobile app')
  .requiredOption('--token <token>', 'Gateway token (gw_live_xxx)')
  .option('--relay <url>', 'Relay HTTP URL', 'http://localhost:8080')
  .option('--name <name>', 'Gateway display name')
  .action(async (opts) => {
    const client = new GatewayClient({
      relayUrl: opts.relay.replace(/^http/, 'ws') + '/v1/tunnel',
      token: opts.token,
      gatewayName: opts.name,
      reconnect: false,
    });

    try {
      const { code, expiresAt } = await client.createPairingCode(opts.relay);
      const expires = new Date(expiresAt);
      const remaining = Math.ceil(
        (expires.getTime() - Date.now()) / 1000 / 60,
      );

      console.log('\n  Pairing Mode');
      console.log('  ' + '─'.repeat(40));
      console.log();

      // Generate QR code in terminal
      const deepLink = `agentdraw://pair?code=${code}&relay=${new URL(opts.relay).host}&name=${encodeURIComponent(opts.name ?? 'Gateway')}`;

      try {
        const qrcode = await import('qrcode-terminal');
        qrcode.default.generate(deepLink, { small: true }, (qr: string) => {
          console.log('  Scan this QR code with AgentDraw:\n');
          for (const line of qr.split('\n')) {
            console.log('    ' + line);
          }
        });
      } catch {
        console.log(`  QR link: ${deepLink}`);
      }

      console.log();
      console.log(`  Or enter this code manually: ${code}`);
      console.log(`  Expires in ${remaining} minutes`);
      console.log();
      console.log('  Waiting for connection...');

      // Poll until code is used or expires
      const pollInterval = setInterval(async () => {
        if (Date.now() > expires.getTime()) {
          clearInterval(pollInterval);
          console.log('\n  Pairing code expired.');
          process.exit(1);
        }
      }, 5000);

      process.on('SIGINT', () => {
        clearInterval(pollInterval);
        console.log('\n  Cancelled.');
        process.exit(0);
      });
    } catch (err) {
      console.error(
        `Failed to create pairing code: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program
  .command('devices')
  .description('List connected app devices')
  .requiredOption('--token <token>', 'Gateway token (gw_live_xxx)')
  .option('--relay <url>', 'Relay HTTP URL', 'http://localhost:8080')
  .action(async (opts) => {
    const client = new GatewayClient({
      relayUrl: opts.relay.replace(/^http/, 'ws') + '/v1/tunnel',
      token: opts.token,
      reconnect: false,
    });

    try {
      const apps = await client.listApps(opts.relay);

      console.log('\n  Connected Devices');
      console.log('  ' + '─'.repeat(40));

      if (apps.length === 0) {
        console.log('\n  No devices connected.');
        console.log('  Run `openclaw-relay pair` to connect a device.\n');
      } else {
        for (const [i, app] of apps.entries()) {
          console.log(`\n  ${i + 1}. ${app.deviceName}`);
          console.log(`     ID: ${app.id}`);
          console.log(`     Connected: ${app.createdAt}`);
          console.log(`     Last active: ${app.lastUsedAt}`);
        }
        console.log();
      }
    } catch (err) {
      console.error(
        `Failed to list devices: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program.parse();
