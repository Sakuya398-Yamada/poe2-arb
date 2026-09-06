import { defineConfig } from 'vitest/config';

export default defineConfig({
	root: 'web',
	build: { outDir: '../dist', emptyOutDir: true },
	server: {
		port: 5173,
		proxy: { '/api': 'http://127.0.0.1:8765' },
	},
	test: {
		root: '.',
		include: ['test/**/*.test.ts'],
	},
});
