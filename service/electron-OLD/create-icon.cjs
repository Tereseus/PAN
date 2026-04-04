// Generate a PAN tray icon (32x32 blue square with white Π)
// Creates pan-icon.png using raw pixel manipulation

const fs = require('fs');
const path = require('path');

// We'll create a BMP-style image and convert to PNG-compatible format
// Actually, let's use Electron's offscreen rendering to make the icon

// Simple approach: create an SVG and let Electron render it
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="40" fill="#1565C0"/>
  <text x="128" y="195" font-family="serif" font-size="200" font-weight="bold" fill="white" text-anchor="middle">Π</text>
</svg>`;

fs.writeFileSync(path.join(__dirname, 'pan-icon.svg'), svg);
console.log('Created pan-icon.svg');

// Also create an HTML file that Electron can screenshot for the icon
const html = `<!DOCTYPE html>
<html><head><style>
body { margin: 0; padding: 0; width: 256px; height: 256px; background: #1565C0; display: flex; align-items: center; justify-content: center; border-radius: 40px; }
div { color: white; font-size: 200px; font-weight: bold; font-family: serif; margin-top: -20px; }
</style></head><body><div>Π</div></body></html>`;

fs.writeFileSync(path.join(__dirname, 'icon-render.html'), html);
console.log('Created icon-render.html');
