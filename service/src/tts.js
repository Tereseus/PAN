// PAN TTS — Voice synthesis with F5-TTS voice cloning
//
// Architecture:
//   1. Voice profiles: reference WAV files in data/voices/<name>.wav (15s clips)
//   2. Common phrases: pre-generated per voice, cached in data/voices/<name>/phrases/
//   3. On-demand: novel text → F5-TTS (GPU) → WAV → stream to client
//   4. Voice packs: ZIP bundles (reference + pre-generated phrases) downloadable by phone
//
// Flow:
//   Personality "Arnold" → lookup voice profile "arnold" → check phrase cache →
//   hit? return cached WAV : generate via F5-TTS → cache → return WAV

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { getDataDir } from './platform.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const VOICES_DIR = join(getDataDir(), 'voices');
const PYTHON = process.platform === 'win32' ? 'python.exe' : 'python3';
const TTS_SCRIPT = join(__dirname, 'tts-worker.py');

// Ensure voices dir exists
try { mkdirSync(VOICES_DIR, { recursive: true }); } catch {}

// Common phrases that get pre-generated per voice profile
const COMMON_PHRASES = [
  "Got it.", "Working on it.", "Done.", "Here's what I found.",
  "One moment.", "I'm on it.", "Sure thing.", "Let me check.",
  "All set.", "Ready.", "Processing.", "Right away.",
  "Hello.", "Goodbye.", "Yes.", "No.", "Understood.",
  "I'll take care of it.", "Something went wrong.", "Try again.",
  "Good morning.", "Good night.", "What's next?",
  "That's interesting.", "I agree.", "Let me think about that.",
  "Here you go.", "No problem.", "You're welcome.",
  "I don't know.", "Let me look into that.", "Give me a second.",
  "Perfect.", "Exactly.", "Of course.", "Absolutely.",
  "I'm listening.", "Go ahead.", "Tell me more.",
  "That's done.", "Task complete.", "Message sent.",
  "Connected.", "Disconnected.", "Server restarted.",
  "New message.", "Reminder.", "Alert.",
];

// Hash text to create cache-safe filename
function phraseHash(text) {
  return createHash('md5').update(text.toLowerCase().trim()).digest('hex').slice(0, 12);
}

// Get voice profile directory
function voiceDir(voiceName) {
  const dir = join(VOICES_DIR, voiceName.toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Check if a voice profile exists (has reference WAV)
export function hasVoiceProfile(voiceName) {
  const dir = voiceDir(voiceName);
  return existsSync(join(dir, 'reference.wav'));
}

// List all available voice profiles
export function listVoiceProfiles() {
  if (!existsSync(VOICES_DIR)) return [];
  return readdirSync(VOICES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(VOICES_DIR, d.name, 'reference.wav')))
    .map(d => {
      const phrasesDir = join(VOICES_DIR, d.name, 'phrases');
      const phraseCount = existsSync(phrasesDir)
        ? readdirSync(phrasesDir).filter(f => f.endsWith('.wav')).length : 0;
      return {
        name: d.name,
        phrasesCached: phraseCount,
        phrasesTotal: COMMON_PHRASES.length,
        referenceExists: true,
      };
    });
}

// Get cached phrase WAV path (or null if not cached)
function getCachedPhrase(voiceName, text) {
  const hash = phraseHash(text);
  const wavPath = join(voiceDir(voiceName), 'phrases', `${hash}.wav`);
  return existsSync(wavPath) ? wavPath : null;
}

// Generate speech via F5-TTS (calls Python worker)
export async function synthesize(text, voiceName, opts = {}) {
  const dir = voiceDir(voiceName);
  const refWav = join(dir, 'reference.wav');

  if (!existsSync(refWav)) {
    throw new Error(`No reference audio for voice "${voiceName}". Upload a reference.wav first.`);
  }

  // Check phrase cache first
  const cached = getCachedPhrase(voiceName, text);
  if (cached && !opts.noCache) {
    return { path: cached, cached: true };
  }

  // Generate via F5-TTS Python worker
  const hash = phraseHash(text);
  const phrasesDir = join(dir, 'phrases');
  if (!existsSync(phrasesDir)) mkdirSync(phrasesDir, { recursive: true });
  const outPath = join(phrasesDir, `${hash}.wav`);

  await new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [TTS_SCRIPT, refWav, text, outPath], {
      timeout: 30000,
      windowsHide: true,
      env: { ...process.env },
    });

    let stderr = '';
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', (code) => {
      if (code === 0 && existsSync(outPath)) resolve();
      else reject(new Error(`TTS failed (code ${code}): ${stderr.slice(-500)}`));
    });
    proc.on('error', reject);
  });

  return { path: outPath, cached: false };
}

// Pre-generate all common phrases for a voice (run in background)
export async function pregenerate(voiceName, onProgress) {
  const results = { total: COMMON_PHRASES.length, done: 0, errors: 0 };

  for (const phrase of COMMON_PHRASES) {
    try {
      const cached = getCachedPhrase(voiceName, phrase);
      if (cached) {
        results.done++;
        continue;
      }
      await synthesize(phrase, voiceName);
      results.done++;
      if (onProgress) onProgress(results);
    } catch (e) {
      results.errors++;
      console.error(`[TTS] Failed to generate "${phrase}" for ${voiceName}: ${e.message}`);
    }
  }
  return results;
}

// Save a reference WAV for a voice profile
export function saveReference(voiceName, wavBuffer) {
  const dir = voiceDir(voiceName);
  const refPath = join(dir, 'reference.wav');
  writeFileSync(refPath, wavBuffer);
  console.log(`[TTS] Saved reference audio for "${voiceName}" (${wavBuffer.length} bytes)`);
  return refPath;
}

// Stream a WAV file
export function streamWav(wavPath) {
  return createReadStream(wavPath);
}
