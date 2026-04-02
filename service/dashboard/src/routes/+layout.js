// Disable SSR — this is a static SPA (adapter-static)
// Required for dev mode since window/localStorage don't exist during SSR
export const ssr = false;
export const prerender = true;
