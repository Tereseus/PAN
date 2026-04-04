// Opens the PAN Dev Dashboard in an Electron window
// Auto-selects Tests panel and auto-runs all test suites
// Usage: npx electron open-dev-dashboard.cjs [port]
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const DEV_PORT = process.argv[2] || 7781;

// Isolate dev Electron from production — separate userData so no profile conflicts
const devDataDir = path.join(os.tmpdir(), 'pan-dev-electron');
try { fs.mkdirSync(devDataDir, { recursive: true }); } catch {}
app.setPath('userData', devDataDir);
app.setPath('sessionData', path.join(devDataDir, 'session'));
app.setPath('cache', path.join(devDataDir, 'cache'));
app.setPath('crashDumps', path.join(devDataDir, 'crashes'));

function triggerTests() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: DEV_PORT,
      path: '/api/v1/tests/run',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.write(JSON.stringify({ suite: 'all' }));
    req.end();
  });
}

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'electron', 'pan-icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,  // show after ready to avoid blank flash
    title: `\u03A0\u0391\u039D Dev Dashboard (:${DEV_PORT})`,
    icon: icon,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    console.log('[PAN Dev] Window shown and focused');
  });

  win.loadURL(`http://127.0.0.1:${DEV_PORT}/v2/terminal`);

  // After page loads: select Tests panel in LEFT sidebar, then auto-run tests
  win.webContents.on('did-finish-load', () => {
    // Wait for Svelte to hydrate and mount components (~2s)
    setTimeout(() => {
      // Select "Tests" in the LEFT panel dropdown
      // Both panels use class .right-select — left panel is inside .left-panel
      win.webContents.executeJavaScript(`
        (function() {
          const leftSelect = document.querySelector('.left-panel .right-select');
          if (!leftSelect) { console.warn('[PAN Dev] No left panel select found'); return false; }

          // Find the Tests option index
          const options = Array.from(leftSelect.options);
          const testsIdx = options.findIndex(o => o.value === 'tests');
          if (testsIdx < 0) { console.warn('[PAN Dev] No tests option found'); return false; }

          // Set selectedIndex and fire native events to trigger Svelte bind:value
          leftSelect.selectedIndex = testsIdx;
          leftSelect.dispatchEvent(new Event('input', { bubbles: true }));
          leftSelect.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('[PAN Dev] Selected Tests panel in left sidebar');
          return true;
        })();
      `).then(ok => {
        if (ok) console.log('[PAN Dev] Tests panel selected');
        else console.warn('[PAN Dev] Could not select Tests panel');
      }).catch(err => console.error('[PAN Dev] JS inject error:', err));

      // After panel switches, click "Run All Tests" button (give it 2s to render)
      setTimeout(() => {
        win.webContents.executeJavaScript(`
          (function() {
            const btn = document.querySelector('.left-panel .test-run-btn');
            if (btn && !btn.disabled) {
              btn.click();
              console.log('[PAN Dev] Clicked Run Tests button');
              return true;
            }
            console.warn('[PAN Dev] No run button found or button disabled, triggering via API');
            return false;
          })();
        `).then(clicked => {
          if (!clicked) {
            // Fallback: trigger tests via API
            triggerTests().then(() => console.log('[PAN Dev] Tests triggered via API'));
          }
        }).catch(() => {
          triggerTests().then(() => console.log('[PAN Dev] Tests triggered via API (fallback)'));
        });
      }, 2000);
    }, 2000);
  });

  win.on('closed', () => app.quit());
});
