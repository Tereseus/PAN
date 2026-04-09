// PAN Screen Recorder — low FPS screen capture for bug reporting
// Uses FFmpeg GDI screen capture at 2 FPS
// Start/stop via API or voice command, frames extractable for analysis

import { spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { getRecordingsDir } from './platform.js';

const RECORDINGS_DIR = getRecordingsDir();

let ffmpegProcess = null;
let currentFile = null;
let startTime = null;

function ensureDir() {
  if (!existsSync(RECORDINGS_DIR)) {
    mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
}

export function startRecording(options = {}) {
  if (ffmpegProcess) {
    return { error: 'Already recording', file: currentFile };
  }

  ensureDir();

  const fps = options.fps || 2;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  currentFile = join(RECORDINGS_DIR, `screen_${ts}.mp4`);
  startTime = Date.now();

  // FFmpeg GDI screen capture on Windows
  // -framerate 2 = 2 FPS (one frame every 500ms)
  // -c:v libx264 -crf 28 = decent quality, small file
  // -pix_fmt yuv420p = compatibility
  const args = [
    '-f', 'gdigrab',
    '-framerate', String(fps),
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-crf', '28',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-y',
    currentFile
  ];

  ffmpegProcess = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[PAN Recorder] FFmpeg error:', err.message);
    ffmpegProcess = null;
    currentFile = null;
  });

  ffmpegProcess.on('exit', (code) => {
    console.log(`[PAN Recorder] FFmpeg exited with code ${code}`);
    ffmpegProcess = null;
  });

  console.log(`[PAN Recorder] Started recording at ${fps} FPS → ${currentFile}`);
  return { status: 'recording', file: currentFile, fps };
}

export function stopRecording() {
  if (!ffmpegProcess) {
    return { error: 'Not recording' };
  }

  const file = currentFile;
  const duration = Math.round((Date.now() - startTime) / 1000);

  // Send 'q' to FFmpeg stdin for graceful stop
  ffmpegProcess.stdin.write('q');
  ffmpegProcess.stdin.end();

  // Force kill after 5 seconds if it doesn't stop
  const killTimer = setTimeout(() => {
    if (ffmpegProcess) {
      ffmpegProcess.kill('SIGKILL');
    }
  }, 5000);

  ffmpegProcess.on('exit', () => {
    clearTimeout(killTimer);
  });

  ffmpegProcess = null;
  currentFile = null;
  startTime = null;

  console.log(`[PAN Recorder] Stopped recording (${duration}s) → ${file}`);
  return { status: 'stopped', file, duration };
}

export function extractFrames(videoFile, options = {}) {
  const outputDir = options.outputDir || videoFile.replace('.mp4', '_frames');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Extract every frame as PNG
  const fps = options.fps || 2;
  const args = [
    '-i', videoFile,
    '-vf', `fps=${fps}`,
    join(outputDir, 'frame_%04d.png')
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'pipe', windowsHide: true });
    proc.on('exit', (code) => {
      if (code === 0) {
        const frames = readdirSync(outputDir).filter(f => f.endsWith('.png')).sort();
        resolve({ outputDir, frameCount: frames.length, frames });
      } else {
        reject(new Error(`FFmpeg frame extraction failed with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

export function getRecordingStatus() {
  return {
    recording: !!ffmpegProcess,
    file: currentFile,
    duration: startTime ? Math.round((Date.now() - startTime) / 1000) : 0
  };
}

export function listRecordings() {
  ensureDir();
  return readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => {
      const full = join(RECORDINGS_DIR, f);
      const stat = statSync(full);
      return { file: f, path: full, size: stat.size, created: stat.mtime };
    })
    .sort((a, b) => b.created - a.created);
}
