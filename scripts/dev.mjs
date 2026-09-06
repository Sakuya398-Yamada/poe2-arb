// Runs the API server (tsx watch) and the Vite dev server together. No extra deps.
import { spawn } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const procs = [
	spawn(npx, ['tsx', 'watch', 'server/index.ts'], { stdio: 'inherit', shell: process.platform === 'win32' }),
	spawn(npx, ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code && code !== 0) stop(); });
