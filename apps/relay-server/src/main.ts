import 'dotenv/config';
import { createRelayServer } from '@openclaw/relay-server';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_PATH = process.env.DATABASE_PATH ?? './relay.db';
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS ?? '30000', 10);
const HEARTBEAT_TIMEOUT_MULTIPLIER = parseFloat(process.env.HEARTBEAT_TIMEOUT_MULTIPLIER ?? '3');
const GRACE_PERIOD_MS = parseInt(process.env.GRACE_PERIOD_MS ?? '45000', 10);

async function main(): Promise<void> {
  const relay = await createRelayServer({
    port: PORT,
    host: HOST,
    dbPath: DATABASE_PATH,
    heartbeatMs: HEARTBEAT_MS,
    heartbeatTimeoutMultiplier: HEARTBEAT_TIMEOUT_MULTIPLIER,
    gracePeriodMs: GRACE_PERIOD_MS,
  });

  relay.hub.on('gateway:connected', ({ id, name }) => {
    console.log(`Gateway connected: ${id} (${name})`);
  });

  relay.hub.on('gateway:reconnected', ({ id, name }: { id: string; name: string }) => {
    console.log(`Gateway reconnected: ${id} (${name})`);
  });

  relay.hub.on('gateway:reconnecting', ({ id }: { id: string }) => {
    console.log(`Gateway reconnecting: ${id} (grace period)`);
  });

  relay.hub.on('gateway:disconnected', ({ id, reason }) => {
    console.log(`Gateway disconnected: ${id} (${reason})`);
  });

  const address = await relay.listen();
  console.log(`OpenClaw Relay Server listening on ${address}`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    await relay.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
