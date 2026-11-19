// PAN Setup's second half on Linux: what PAN talks with (--voice) and the computer's own
// translator (--translator). pan-setup.sh runs it with PAN's own Node once PAN is up.
//
//   node setup-models.cjs --install-dir DIR [--voice] [--translator]
//                         [--own-models DIR|URL] [--model-set light|full] [--quiet]
//
// The lists are in service/model-set.json. Everything comes straight from its publisher to
// this computer (Ollama's releases and library, Hugging Face, astral's uv), checked against a
// published SHA-256 where there is one. Nothing needs an account or root, and all of it
// lands inside the install folder, so removing PAN removes it too. A person's own Ollama, if
// one already answers on this computer, is used as it is and left alone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const installDir = value('--install-dir');
const QUIET = flag('--quiet');
if (!installDir) { console.error('usage: setup-models.cjs --install-dir DIR [--voice] [--translator]'); process.exit(2); }

const configPath = path.join(installDir, 'install.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const target = path.join(installDir, 'app', String(config.version));
const catalog = JSON.parse(fs.readFileSync(path.join(target, 'service', 'model-set.json'), 'utf8'));
const dl = path.join(installDir, 'download');
const PORT = config.port || 7777;
const OLLAMA = (catalog.ollama && catalog.ollama.url) || 'http://127.0.0.1:11434';
const result = {};
fs.mkdirSync(dl, { recursive: true });

function say(text) {
  console.log(text);
  // Local time, like pan-setup.sh writes into the same file.
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  try { fs.appendFileSync(path.join(installDir, 'setup.log'), `${d} ${text}\n`); } catch {}
}
function saveConfig() { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); }
function saveResult() { try { fs.writeFileSync(path.join(installDir, 'setup-models.json'), JSON.stringify(result, null, 2)); } catch {} }
class Stop extends Error {}
const stop = (text) => { throw new Stop(text); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ramGB = os.totalmem() / 2 ** 30;
const setName = value('--model-set') || (ramGB >= 24 ? 'full' : 'light');

function which(name) {
  for (const d of String(process.env.PATH || '').split(':')) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Download to dest, picking a broken download up where it stopped, then check it. */
async function download(url, dest, { sha256, size } = {}) {
  const whole = async (f) => fs.existsSync(f)
    && (size === undefined || fs.statSync(f).size === size)
    && (!sha256 || (await sha256File(f)) === sha256.toLowerCase());
  if (await whole(dest)) return;
  const part = `${dest}.download`;
  for (let attempt = 1; ; attempt++) {
    try {
      let at = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (!(size !== undefined && at === size)) {
        const res = await fetch(url, { headers: at ? { Range: `bytes=${at}-` } : {}, redirect: 'follow' });
        if (res.status === 200) at = 0;                 // the server sent the whole file again
        else if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const out = fs.createWriteStream(part, { flags: at ? 'a' : 'w' });
        for await (const chunk of res.body) { if (!out.write(chunk)) await new Promise((r) => out.once('drain', r)); }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      }
      break;
    } catch (e) {
      if (attempt >= 6) stop(`${path.basename(dest)} did not download (${e.message}). Run PAN Setup again to carry on.`);
      await sleep(3000 * attempt);
    }
  }
  if (size !== undefined && fs.statSync(part).size !== size) { fs.rmSync(part, { force: true }); stop(`${path.basename(dest)} came down the wrong size.`); }
  if (sha256 && (await sha256File(part)) !== sha256.toLowerCase()) {
    fs.rmSync(part, { force: true });
    stop(`${path.basename(dest)} does not match what was published, so it was thrown away.`);
  }
  fs.renameSync(part, dest);
}

function run(cmd, cmdArgs, opt = {}) {
  return new Promise((resolve) => {
    const log = fs.openSync(path.join(dl, 'tools.log'), 'a');
    const child = spawn(cmd, cmdArgs, { cwd: opt.cwd, env: opt.env || process.env, stdio: ['ignore', QUIET ? log : 'inherit', QUIET ? log : 'inherit'] });
    child.on('error', () => resolve(127));
    child.on('exit', (code) => { fs.closeSync(log); resolve(code === null ? 1 : code); });
  });
}

async function panHealthy() {
  try {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4000) })).json();
    if (!(h.craftHealthy === true || h.status === 'running')) return false;
    return (await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/me`, { signal: AbortSignal.timeout(6000) })).status === 200;
  } catch { return false; }
}

/** Start PAN again through whatever keeps it running, and wait for all of it. */
async function restartPan(why) {
  say(`  Restarting PAN ${why}.`);
  const systemd = config.unit && spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;
  if (systemd) {
    if (spawnSync('systemctl', ['--user', 'restart', config.unit], { stdio: 'ignore' }).status !== 0) stop('systemd could not restart PAN.');
  } else {
    try { process.kill(parseInt(fs.readFileSync(path.join(config.dataDir, 'launcher.pid'), 'utf8'), 10), 'SIGTERM'); } catch {}
    await sleep(4000);
    spawn(path.join(installDir, 'start.sh'), [], { detached: true, stdio: 'ignore' }).unref();
  }
  const until = Date.now() + 240000;
  while (Date.now() < until) { await sleep(3000); if (await panHealthy()) return; }
  stop(`PAN did not come back. Its log is ${path.join(config.dataDir, 'hub.log')}`);
}

// ---- voice ---------------------------------------------------------------------------

async function ollamaModels() {
  // null when Ollama does not answer; else the names it holds (maybe none).
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) });
    return ((await r.json()).models || []).map((m) => String(m.name));
  } catch { return null; }
}
const full = (name) => (name.includes(':') ? name : `${name}:latest`).toLowerCase();
const hasModel = (list, name) => list.some((h) => full(h) === full(name));

async function installOllama() {
  say('  Getting Ollama, the program that runs the models.');
  const src = catalog.ollama.linux;
  const file = path.basename(src.url);
  let sums = '';
  try { sums = await (await fetch(src.sums, { redirect: 'follow', signal: AbortSignal.timeout(30000) })).text(); } catch {}
  const line = sums.split('\n').find((l) => l.trim().endsWith(file));
  if (!line) stop('Ollama\'s list of checksums could not be read, so Ollama was not downloaded.');
  const pack = path.join(dl, file);
  await download(src.url, pack, { sha256: line.trim().split(/\s+/)[0] });
  say('  Unpacking Ollama.');
  const dir = path.join(installDir, 'ollama');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // The package is zstd, which a plain Linux often cannot open: Node does that part. The
  // NVIDIA libraries (most of the package) are left out on a computer with no NVIDIA card.
  const tarArgs = ['-xf', '-', '-C', dir];
  if (!fs.existsSync('/proc/driver/nvidia') && !which('nvidia-smi')) tarArgs.push('--exclude=cuda_v*');
  const code = await new Promise((resolve) => {
    const tar = spawn('tar', tarArgs, { stdio: ['pipe', 'ignore', 'inherit'] });
    tar.on('exit', (c) => resolve(c));
    tar.on('error', () => resolve(127));
    fs.createReadStream(pack).pipe(zlib.createZstdDecompress()).on('error', () => { try { tar.kill(); } catch {} }).pipe(tar.stdin);
  });
  const exe = path.join(dir, 'bin', 'ollama');
  if (code !== 0 || !fs.existsSync(exe)) stop('Ollama did not unpack.');
  fs.rmSync(pack, { force: true });
  config.ollama = exe;
  config.ollamaInstalledBySetup = true;
  // Its models stay inside the install folder too, so removing PAN removes them.
  config.ollamaModels = path.join(installDir, 'ollama-models');
  saveConfig();
  return exe;
}

async function voice() {
  say('');
  say('> Getting what PAN talks with');
  const wanted = catalog.models.filter((m) => m.sets.includes(setName)).sort((a, b) => a.gb - b.gb);
  const gb = wanted.reduce((n, m) => n + m.gb, 0);
  say(`  ${wanted.length} models, ${gb.toFixed(1)} GB, for a computer with ${ramGB.toFixed(1)} GB of memory`);

  let have = await ollamaModels();
  let exe = (config.ollama && fs.existsSync(config.ollama)) ? config.ollama : which('ollama');
  if (have === null) {
    if (!exe) exe = await installOllama();
    // PAN's launcher runs it from now on (and at every start), so start it that way.
    config.ollama = exe;
    saveConfig();
    await restartPan('so its launcher starts Ollama');
    for (let i = 0; i < 90 && have === null; i++) { await sleep(2000); have = await ollamaModels(); }
    if (have === null) stop('Ollama is installed but does not answer.');
  } else if (!exe) {
    stop('An Ollama answers on this computer, but its program is not on the PATH, so models cannot be added to it.');
  }
  say('  Ollama is running.');
  config.modelsAdded = config.modelsAdded || [];

  const own = value('--own-models');
  const ownDir = path.join(dl, 'own-models');
  for (const m of wanted) {
    const name = String(m.name);
    if (hasModel(have, name)) { say(`  have    ${name}`); continue; }
    if (m.from === 'ollama') {
      say(`  getting ${name} (${m.gb} GB): ${m.what}`);
      if (await run(exe, ['pull', name]) !== 0) stop(`${name} did not download. Run PAN Setup again to carry on.`);
    } else {
      const web = /^https?:\/\//.test(own);
      const here = web || (own && fs.existsSync(path.join(own, m.file)));
      if (!here) {
        say(`  ! ${name} is PAN's own model and has no public download yet. Skipped.`);
        if (m.standIn && !hasModel(have, m.standIn)) {
          say(`  getting ${m.standIn} in its place`);
          if (await run(exe, ['pull', m.standIn]) === 0) { config.modelsAdded.push(m.standIn); saveConfig(); }
        }
        continue;
      }
      say(`  getting ${name} (${m.gb} GB): ${m.what}`);
      fs.mkdirSync(ownDir, { recursive: true });
      const gguf = path.join(ownDir, m.file);
      if (web) await download(`${own.replace(/\/$/, '')}/${m.file}`, gguf);
      else fs.copyFileSync(path.join(own, m.file), gguf);
      const short = name.split(':')[0];
      fs.copyFileSync(path.join(target, 'service', 'model-files', `${short}.Modelfile`), path.join(ownDir, `${short}.Modelfile`));
      if (await run(exe, ['create', name, '-f', `${short}.Modelfile`], { cwd: ownDir }) !== 0) stop(`Ollama could not take ${name}.`);
      fs.rmSync(gguf, { force: true });   // Ollama keeps its own copy
    }
    config.modelsAdded.push(name);
    saveConfig();
  }
  fs.rmSync(ownDir, { recursive: true, force: true });

  // Point PAN at what is here, and start it again so it picks its talking model up.
  let applied;
  try {
    applied = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/setup/models/apply`, { method: 'POST', signal: AbortSignal.timeout(30000) })).json();
  } catch (e) { stop(`PAN did not take the model settings: ${e.message}`); }
  result.voice = { set: setName, canTalk: !!applied.voice, missing: applied.missing || [], models: config.modelsAdded };
  if ((applied.missing || []).length) say(`  ! Not here: ${applied.missing.join(', ')}`);
  await restartPan('with its models');
  say('  Asking PAN to say hello (the first answer loads the model, so it is the slow one).');
  let check = { ok: false };
  for (let i = 0; i < 4 && !check.ok; i++) {
    const p = spawnSync(process.execPath, [path.join(target, 'launcher', 'voice-check.cjs'), String(PORT)], { encoding: 'utf8', timeout: 300000 });
    try { check = JSON.parse(String(p.stdout || '').trim().split('\n').pop()); } catch { check = { ok: false, error: String(p.stderr || '').slice(-200) }; }
    if (!check.ok) await sleep(10000);
  }
  result.voice.check = check;
  if (check.ok) {
    say(`  PAN said: "${check.reply}" (first word after ${(check.firstMs / 1000).toFixed(1)} s)`);
    say('  PAN answers a spoken line.');
  } else {
    say('  ! The models are in, but PAN did not answer a spoken line.');
    result.voice.canTalk = false;
  }
}

// ---- the translator ------------------------------------------------------------------

async function translator() {
  say('');
  say('> Getting the translator');
  const tr = catalog.translator;
  const models = tr.models.filter((m) => m.sets.includes(setName)).sort((a, b) => a.gb - b.gb);
  const trDir = path.join(installDir, 'translate');
  const venv = path.join(trDir, 'venv');
  const py = path.join(venv, 'bin', 'python');
  fs.mkdirSync(trDir, { recursive: true });

  // Its own Python, inside the install folder, so nothing on the computer is touched. uv is
  // one small program that fetches Python and the two packages; it is checked against its
  // published SHA-256 before it runs.
  const pyOk = fs.existsSync(py) && spawnSync(py, ['-c', 'import ctranslate2, sentencepiece'], { stdio: 'ignore' }).status === 0;
  if (!pyOk) {
    say('  Setting up Python for the translator.');
    const pack = path.join(dl, 'uv.tar.gz');
    await download(tr.uv.linux.url, pack, { sha256: tr.uv.linux.sha256 });
    const uvDir = path.join(trDir, 'uv');
    fs.rmSync(uvDir, { recursive: true, force: true });
    fs.mkdirSync(uvDir, { recursive: true });
    if (spawnSync('tar', ['-xzf', pack, '-C', uvDir, '--strip-components=1']).status !== 0) stop('The translator\'s installer did not unpack.');
    const uv = path.join(uvDir, 'uv');
    if (!fs.existsSync(uv)) stop('The translator\'s installer is missing parts.');
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(trDir, 'python'), UV_CACHE_DIR: path.join(trDir, 'cache'), UV_NO_PROGRESS: '1' };
    fs.rmSync(venv, { recursive: true, force: true });
    for (const step of [['venv', '--python', String(tr.python), venv], ['pip', 'install', '--python', py, ...tr.packages.map(String)]]) {
      const code = await run(uv, step, { env });
      if (code !== 0) stop(`Python for the translator did not install (uv ${step[0]}, code ${code}). See ${path.join(dl, 'tools.log')}`);
    }
    for (const junk of [path.join(trDir, 'cache'), uvDir, pack]) fs.rmSync(junk, { recursive: true, force: true });
  }
  say('  Python is ready.');

  for (const m of models) {
    const mdir = path.join(installDir, 'models', String(m.name));
    fs.mkdirSync(mdir, { recursive: true });
    const todo = m.files.filter((f) => { const p = path.join(mdir, f.name); return !(fs.existsSync(p) && fs.statSync(p).size === f.size); });
    if (!todo.length) { say(`  have    ${m.name}`); continue; }
    say(`  getting ${m.name} (${m.gb} GB): ${m.what}`);
    for (const f of todo) {
      if (!/^[0-9A-Za-z._-]+$/.test(f.name)) stop('The translator\'s list names a file that is not allowed.');
      await download(`https://huggingface.co/${m.repo}/resolve/${m.rev}/${f.name}`, path.join(mdir, f.name), { size: f.size, sha256: f.sha256 });
    }
  }
  fs.mkdirSync(path.join(installDir, 'logs'), { recursive: true });

  await restartPan('with its translator');
  let said = '';
  for (let i = 0; i < 40 && !said; i++) {
    await sleep(3000);
    try {
      const r = await fetch('http://127.0.0.1:7784/translate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ text: 'Good morning. Where is the train station?', src: 'en', tgt: 'es' }),
      });
      said = String((await r.json()).text || '');
    } catch {}
  }
  result.translator = { set: setName, models: models.map((m) => m.name), spanish: said };
  if (said) say('  The translator answers (English to Spanish checked).');
  else say(`  ! The translator is installed but did not answer. Its log is ${path.join(installDir, 'logs', 'translate.log')}`);
}

(async () => {
  try {
    if (flag('--voice')) await voice();
    if (flag('--translator')) await translator();
    result.ok = true;
    saveResult();
    process.exit(0);
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    saveResult();
    say('');
    say(e instanceof Stop ? `PAN Setup stopped: ${e.message}` : `PAN Setup stopped on an error of its own: ${e.stack || e.message}`);
    process.exit(1);
  }
})();
