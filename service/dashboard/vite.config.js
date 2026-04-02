import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5173,
		proxy: {
			// Proxy API calls to PAN server
			'/api': 'http://127.0.0.1:7777',
			'/dashboard/api': 'http://127.0.0.1:7777',
			'/ws/terminal': {
				target: 'ws://127.0.0.1:7777',
				ws: true
			}
		}
	}
});
