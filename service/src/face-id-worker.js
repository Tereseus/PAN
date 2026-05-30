// PAN Face Identity — WORKER THREAD
//
// Why a worker thread:
// face-api.js runs 4 chained CNN inferences (SsdMobilenetv1, FaceLandmarks,
// FaceExpressions, FaceDescriptor) via @vladmandic/face-api's WASM backend.
// The WASM tensor ops are SYNCHRONOUS from V8's perspective — once we hand
// control to them, no setTimeout / AbortController / signal can preempt.
// Under CPU contention they have been observed at 149-176 seconds per cycle,
// freezing the entire Craft event loop (dashboard 502s, Steward heartbeats
// miss, panels unresponsive). See task #58 (mitigations) and #59 (this fix).
//
// Running the work in a separate thread means the Craft main loop stays free
// regardless of how slow inference is. Slow inference still produces stale
// presence data, but never freezes the UI.
//
// Protocol (parent ↔ worker):
//   parent → { type: 'init',    enrolledLabel, referenceDir, referenceFiles, matchThreshold, autoenrollThreshold, autoenrollMax }
//   worker → { type: 'init_ok', enrolledCount }            on successful enrollment
//   worker → { type: 'init_err', error }                   on init failure
//   parent → { type: 'identify', id, base64 }              per webcam frame
//   worker → { type: 'result', id, present, identity, confidence, expression }
//   worker → { type: 'status', modelsLoaded, enrolledLabel, enrolledCount, autoEnrolledCount, threshold, autoEnrollThreshold }
//                                                          on parent's { type: 'status_query' }

import { parentPort } from 'worker_threads';
import { createCanvas, loadImage, Image, ImageData, Canvas } from 'canvas';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, '../node_modules/@vladmandic/face-api/model');

let modelsLoaded = false;
let enrolledLabel = null;
let enrolledDescriptors = [];
let autoDescriptors = [];
let cfg = { matchThreshold: 0.60, autoenrollThreshold: 35, autoenrollMax: 20 };

async function initOnce(params) {
  if (modelsLoaded) return { enrolledCount: enrolledDescriptors.length };

  enrolledLabel = params.enrolledLabel || null;
  cfg.matchThreshold = params.matchThreshold ?? cfg.matchThreshold;
  cfg.autoenrollThreshold = params.autoenrollThreshold ?? cfg.autoenrollThreshold;
  cfg.autoenrollMax = params.autoenrollMax ?? cfg.autoenrollMax;

  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
  await faceapi.tf.ready();

  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH),
    faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH),
    faceapi.nets.faceExpressionNet.loadFromDisk(MODEL_PATH),
    faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH),
  ]);

  // Enroll reference faces (worker side — main has already filtered the file list)
  enrolledDescriptors = [];
  const refDir = params.referenceDir;
  const refFiles = params.referenceFiles || [];
  for (const filename of refFiles) {
    const filepath = `${refDir}/${filename}`;
    if (!existsSync(filepath)) continue;
    try {
      const img = await loadImage(filepath);
      const canvas = createCanvas(img.width, img.height);
      canvas.getContext('2d').drawImage(img, 0, 0);
      const det = await faceapi
        .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (det) enrolledDescriptors.push(det.descriptor);
    } catch {}
  }
  modelsLoaded = true;
  return { enrolledCount: enrolledDescriptors.length };
}

async function identify(base64) {
  const buf = Buffer.from(base64, 'base64');
  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);

  // ─── THE EXPENSIVE PART — was sync-blocking the main thread, now it's this thread ───
  const detection = await faceapi
    .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
    .withFaceLandmarks()
    .withFaceExpressions()
    .withFaceDescriptor();

  if (!detection) {
    return { present: false, identity: 'unknown', confidence: 0, expression: 'none' };
  }

  const rawExpr = Object.entries(detection.expressions).sort((a, b) => b[1] - a[1])[0][0];
  const expression = rawExpr.charAt(0).toUpperCase() + rawExpr.slice(1);

  let identity = 'unknown';
  let confidence = 0;
  const allRefs = [...enrolledDescriptors, ...autoDescriptors];
  if (allRefs.length > 0) {
    let best = Infinity;
    for (const ref of allRefs) {
      const d = faceapi.euclideanDistance(detection.descriptor, ref);
      if (d < best) best = d;
    }
    if (best < cfg.matchThreshold) {
      identity = enrolledLabel || 'unknown';
      confidence = Math.round((1 - best / cfg.matchThreshold) * 100);
      // Auto-enroll happens here (worker-side) — we never need to round-trip
      // the descriptor back to main; it lives only in the worker's memory.
      if (confidence >= cfg.autoenrollThreshold && autoDescriptors.length < cfg.autoenrollMax) {
        autoDescriptors.push(detection.descriptor);
      }
    }
  }
  return { present: true, identity, confidence, expression };
}

function statusSnapshot() {
  return {
    type: 'status',
    modelsLoaded,
    enrolledLabel,
    enrolledCount: enrolledDescriptors.length,
    autoEnrolledCount: autoDescriptors.length,
    threshold: cfg.matchThreshold,
    autoEnrollThreshold: cfg.autoenrollThreshold,
  };
}

parentPort?.on('message', async (msg) => {
  try {
    if (msg?.type === 'init') {
      const result = await initOnce(msg);
      parentPort.postMessage({ type: 'init_ok', ...result });
      return;
    }
    if (msg?.type === 'identify') {
      const r = await identify(msg.base64);
      parentPort.postMessage({ type: 'result', id: msg.id, ...r });
      return;
    }
    if (msg?.type === 'status_query') {
      parentPort.postMessage(statusSnapshot());
      return;
    }
    if (msg?.type === 'enroll') {
      // Enroll a new face descriptor from a base64 image. The descriptor
      // joins enrolledDescriptors immediately (no model reload, no main-thread
      // bounce) so the very next webcam capture can identify the person.
      // Parent saves the image to disk so it survives Craft restart.
      if (!modelsLoaded) {
        parentPort.postMessage({ type: 'enroll_result', id: msg.id, ok: false, error: 'models not loaded' });
        return;
      }
      try {
        const buf = Buffer.from(msg.base64, 'base64');
        const img = await loadImage(buf);
        const canvas = createCanvas(img.width, img.height);
        canvas.getContext('2d').drawImage(img, 0, 0);
        const det = await faceapi
          .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (!det) {
          parentPort.postMessage({ type: 'enroll_result', id: msg.id, ok: false, error: 'no face detected in image' });
          return;
        }
        enrolledDescriptors.push(det.descriptor);
        // If the parent provided a new label (first enrollment for a person),
        // adopt it so identify() returns this label going forward.
        if (msg.label) enrolledLabel = msg.label;
        parentPort.postMessage({
          type: 'enroll_result', id: msg.id, ok: true,
          enrolledCount: enrolledDescriptors.length,
          label: enrolledLabel,
        });
      } catch (err) {
        parentPort.postMessage({ type: 'enroll_result', id: msg.id, ok: false, error: err.message });
      }
      return;
    }
  } catch (err) {
    if (msg?.type === 'init') {
      parentPort.postMessage({ type: 'init_err', error: err.message });
    } else if (msg?.type === 'identify') {
      // Identify errors are non-fatal: respond as if nobody was there so the
      // watcher can keep running. The error gets logged on the parent side.
      parentPort.postMessage({
        type: 'result', id: msg.id,
        present: false, identity: 'unknown', confidence: 0, expression: 'none',
        error: err.message,
      });
    } else if (msg?.type === 'enroll') {
      parentPort.postMessage({ type: 'enroll_result', id: msg.id, ok: false, error: err.message });
    }
  }
});
