import { buildSync } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

mkdirSync('bin', { recursive: true });

buildSync({
  entryPoints: ['../gateway/src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'bin/agentdraw.js',
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [
    // Node builtins — never bundle
    'node:*',
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'events', 'url', 'util', 'stream', 'net', 'tls', 'zlib', 'buffer',
  ],
  define: {
    'process.env.AGENTDRAW_DEFAULT_RELAY': '"https://divine-freedom-production.up.railway.app"',
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

// Make executable
import { chmodSync } from 'fs';
chmodSync('bin/agentdraw.js', 0o755);
