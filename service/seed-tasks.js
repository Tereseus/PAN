#!/usr/bin/env node
// Seed PAN's project_milestones and project_tasks tables from the master todo list
// Run: node seed-tasks.js

const PAN = 'http://127.0.0.1:7777';

async function post(path, body) {
  const res = await fetch(`${PAN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${PAN}${path}`);
  return res.json();
}

async function seed() {
  // Find PAN project ID
  const projects = await get('/dashboard/api/projects');
  const pan = projects.find(p => p.name === 'PAN');
  if (!pan) {
    console.error('PAN project not found in database. Make sure PAN service is running and project is registered.');
    process.exit(1);
  }
  const pid = pan.id;
  console.log(`Found PAN project: id=${pid}`);

  // Check if tasks already exist
  const existing = await get(`/dashboard/api/projects/${pid}/tasks`);
  if (existing.tasks && existing.tasks.length > 0) {
    console.log(`PAN already has ${existing.tasks.length} tasks. Skipping seed.`);
    console.log('To re-seed, delete existing tasks first.');
    return;
  }

  // Seed milestones and tasks
  const milestones = [
    {
      name: 'Phone App',
      tasks: [
        { title: 'Voice pipeline (Google STT → Anthropic API → TTS)', status: 'done' },
        { title: 'Phone commands (apps, flashlight, timer, alarm, navigation, search, media)', status: 'done' },
        { title: 'Mute/unmute via voice + notification tray toggle + UI toggle', status: 'done' },
        { title: 'Conversation screen shows voice interactions + text input', status: 'done' },
        { title: 'Camera system (CameraX + Claude Vision + photos saved)', status: 'done' },
        { title: 'Notification tray: Mute All + Stop buttons', status: 'done' },
        { title: 'Hardware button press stops TTS', status: 'done' },
        { title: 'Main screen scrollable', status: 'done' },
        { title: 'Dashboard WebView in app', status: 'done' },
        { title: 'Voice data collection pipeline', status: 'done' },
        { title: 'Accessibility service (read screen, tap, type, scroll)', status: 'done' },
        { title: 'Voice fingerprinting (extract from Piper training data)', status: 'todo' },
        { title: 'Voice interrupt while TTS plays', status: 'todo' },
        { title: 'Resistance router integration on phone', status: 'todo' },
        { title: 'Per-device preferences', status: 'todo' },
        { title: '"That didn\'t work" voice command', status: 'todo' },
        { title: 'TTS pause/resume', status: 'todo' },
        { title: 'Spotify auto-play', status: 'todo' },
        { title: 'Calendar integration (Google Calendar)', status: 'todo' },
        { title: 'Transparency logging', status: 'todo' },
        { title: 'Automated pipeline: logged feedback → Claude auto-implements', status: 'todo' },
        { title: 'Audio focus fix', status: 'todo' },
        { title: 'Specific error messages for all failure points', status: 'in_progress' },
      ],
    },
    {
      name: 'PC / Server',
      tasks: [
        { title: 'Terminal launch system with project context', status: 'done' },
        { title: 'PAN service auto-starts (Windows Service)', status: 'done' },
        { title: 'Unified single Claude call router', status: 'done' },
        { title: 'Direct Anthropic API (Haiku, sub-1s)', status: 'done' },
        { title: 'Desktop agent for GUI actions', status: 'done' },
        { title: 'Web dashboard (conversations, data, photos, settings)', status: 'done' },
        { title: 'Password-protected deletes with bulk delete', status: 'done' },
        { title: 'Photos gallery in dashboard', status: 'done' },
        { title: 'Auto-register PC + phone as devices', status: 'done' },
        { title: 'Windows UI Automation (pyautogui + browser extension)', status: 'done' },
        { title: 'Browser extension (list/read/write tabs, click, type)', status: 'done' },
        { title: 'Browser + UI automation unified in router', status: 'done' },
        { title: 'UI element finding (read_text, find_element, click_by_name)', status: 'done' },
        { title: 'Sleep/shutdown from phone', status: 'done' },
        { title: 'Voice recording with hotkey trigger', status: 'done' },
        { title: 'Resistance router (parallel execution, device awareness)', status: 'done' },
        { title: 'Resistance API endpoints', status: 'done' },
        { title: 'Dashboard privacy toggle', status: 'done' },
        { title: 'Single-instance Electron lock', status: 'done' },
        { title: 'MIT LICENSE', status: 'done' },
        { title: 'Single installer (.exe) for new computers', status: 'todo' },
        { title: 'DB persistence fix', status: 'todo' },
        { title: 'Linux support (systemd + AT-SPI2)', status: 'todo' },
      ],
    },
    {
      name: 'Voice / AI',
      tasks: [
        { title: 'Piper voice training pipeline', status: 'in_progress' },
        { title: 'Voice fingerprinting via speaker embeddings', status: 'todo' },
        { title: 'Background retraining (2am-6am)', status: 'todo' },
        { title: 'Custom TTS voices via Piper', status: 'todo' },
        { title: 'Voice marketplace ($1-2 each)', status: 'todo' },
        { title: 'Voice personality packs', status: 'todo' },
        { title: 'Cloud training for no-GPU users', status: 'todo' },
        { title: 'Model push to phone after training', status: 'todo' },
      ],
    },
    {
      name: 'Hardware (Pendant)',
      tasks: [
        { title: 'Order components (ESP32S3, battery, sensors, laser, LED)', status: 'todo' },
        { title: '3D print case design (~52x42x25mm)', status: 'todo' },
        { title: 'Solder I2C sensor board + GPIO expander', status: 'todo' },
        { title: 'ESP32 firmware: BLE, camera, mic VAD, sensors', status: 'todo' },
        { title: 'Phone app BLE connection to pendant', status: 'todo' },
        { title: 'Laser aiming system ("what is this?")', status: 'todo' },
      ],
    },
    {
      name: 'UI / UX',
      tasks: [
        { title: 'App restrictions / blocklist', status: 'todo' },
        { title: 'Browser separation config', status: 'todo' },
        { title: 'RustDesk/Parsec integration ("show me my desktop")', status: 'todo' },
        { title: 'Mobile-friendly PC command center', status: 'todo' },
        { title: 'Home screen layout sync across Android devices', status: 'todo' },
      ],
    },
    {
      name: 'Architecture',
      tasks: [
        { title: 'Device abstraction: register by capabilities', status: 'todo' },
        { title: 'Transport abstraction: HTTP + BLE + Tailscale + WebSocket', status: 'todo' },
        { title: 'AI abstraction: swappable backend', status: 'todo' },
        { title: 'Storage abstraction: swappable backend', status: 'todo' },
        { title: 'BLE device discovery', status: 'todo' },
        { title: 'Work/personal profiles', status: 'todo' },
      ],
    },
    {
      name: 'Security',
      tasks: [
        { title: 'Voice fingerprinting as auth factor', status: 'todo' },
        { title: 'Location-based auth', status: 'todo' },
        { title: 'Device proximity auth (BLE presence)', status: 'todo' },
        { title: 'Multi-factor: fingerprint + location + device', status: 'todo' },
        { title: 'Tailscale for encrypted cross-device comms', status: 'todo' },
      ],
    },
    {
      name: 'Business / Distribution',
      tasks: [
        { title: 'Dev repo on GitHub', status: 'done' },
        { title: 'Public repo (cleaned, separate from dev)', status: 'todo' },
        { title: 'Assembly guide + BOM list for DIY builders', status: 'todo' },
        { title: 'Self-hosted setup documentation', status: 'todo' },
        { title: 'Single installer for Windows (.exe)', status: 'todo' },
        { title: 'Single installer for Linux', status: 'todo' },
        { title: 'Firebase Auth for subscription users', status: 'todo' },
        { title: 'Subscription system (Stripe/Google Pay)', status: 'todo' },
        { title: 'Marketing: "22 sensors, voice control, €155"', status: 'todo' },
      ],
    },
  ];

  for (const m of milestones) {
    console.log(`Creating milestone: ${m.name} (${m.tasks.length} tasks)`);
    const result = await post(`/dashboard/api/projects/${pid}/bulk-tasks`, {
      milestone_name: m.name,
      tasks: m.tasks,
    });
    console.log(`  → Created ${result.created} tasks, milestone_id=${result.milestone_id}`);
  }

  // Verify
  const progress = await get('/dashboard/api/progress');
  const panProgress = progress.projects.find(p => p.id === pid);
  if (panProgress) {
    console.log(`\nPAN Progress: ${panProgress.done_tasks}/${panProgress.total_tasks} tasks (${panProgress.percentage}%)`);
    for (const m of panProgress.milestones) {
      console.log(`  ${m.name}: ${m.done}/${m.total} (${m.percentage}%)`);
    }
  }

  console.log('\nDone! Dashboard will now show live progress.');
}

seed().catch(e => { console.error(e); process.exit(1); });
