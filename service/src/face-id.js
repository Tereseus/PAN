// PAN Face Identity — fast local face recognition via @vladmandic/face-api
//
// No cloud. No LLM. Runs entirely on this machine.
// Enrollment: compute 128-d face embedding from reference photo(s) at startup.
// Per capture: detect face → embedding → L2 distance vs enrolled → match/no-match.
// Typical time: 200–600ms (vs 100s with minicpm-v).

import { createCanvas, loadImage, Image, ImageData, Canvas } from 'canvas';
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, '../node_modules/@vladmandic/face-api/model');

const REFERENCE_DIR   = 'C:/Users/tzuri/Desktop/Me_pics';
// Portrait is the clearest face shot — others add coverage
const REFERENCE_FILES = ['portait.png', 'me_London.png', 'me_club.png', 'me_island.png'];

const MATCH_THRESHOLD      = 0.60; // L2 distance; lower = stricter
const AUTOENROLL_THRESHOLD = 0.80; // confidence % to auto-enroll a live frame
const AUTOENROLL_MAX       = 20;   // cap in-memory auto-enrolled descriptors

let modelsLoaded   = false;
let enrolledLabel  = null;           // name of enrolled person
let enrolledDescriptors = [];        // Float32Array[] — reference photos
let autoDescriptors     = [];        // Float32Array[] — learned from live captures

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initFaceId() {
  if (modelsLoaded) return;

  // Patch canvas for Node.js
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

  // WASM backend must be fully initialised before loading model weights
  await faceapi.tf.ready();

  console.log('[FaceID] Loading models...');
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH),
    faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH),
    faceapi.nets.faceExpressionNet.loadFromDisk(MODEL_PATH),
    faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH),
  ]);
  modelsLoaded = true;
  console.log('[FaceID] Models loaded');

  await enrollReference();
}

async function enrollReference() {
  enrolledDescriptors = [];
  let loaded = 0;

  for (const filename of REFERENCE_FILES) {
    const filepath = `${REFERENCE_DIR}/${filename}`;
    if (!existsSync(filepath)) continue;

    try {
      const img        = await loadImage(filepath);
      const canvas     = createCanvas(img.width, img.height);
      const ctx        = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const detection = await faceapi
        .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection) {
        enrolledDescriptors.push(detection.descriptor);
        loaded++;
        console.log(`[FaceID] Enrolled face from ${filename}`);
      } else {
        console.warn(`[FaceID] No face detected in ${filename} — skipping`);
      }
    } catch (e) {
      console.warn(`[FaceID] Failed to enroll ${filename}: ${e.message}`);
    }
  }

  if (enrolledDescriptors.length > 0) {
    enrolledLabel = 'Tereseus'; // TODO: pull from DB users table
    console.log(`[FaceID] Enrolled "${enrolledLabel}" from ${loaded} photo(s)`);
  } else {
    console.warn('[FaceID] No faces enrolled — identity will always be "unknown"');
  }
}

// ── Per-frame identification ──────────────────────────────────────────────────

/**
 * Identify a person in a webcam frame.
 * @param {string} base64 - JPEG/PNG base64 of the webcam frame
 * @returns {{ present: boolean, identity: string, confidence: number, expression: string }}
 */
export async function identifyFromFrame(base64) {
  if (!modelsLoaded) await initFaceId();

  const buf  = Buffer.from(base64, 'base64');
  const img  = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);

  const detection = await faceapi
    .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
    .withFaceLandmarks()
    .withFaceExpressions()
    .withFaceDescriptor();

  if (!detection) {
    return { present: false, identity: 'unknown', confidence: 0, expression: 'none' };
  }

  // Expression — pick highest scoring
  const expr       = detection.expressions;
  const rawExpr    = Object.entries(expr).sort((a, b) => b[1] - a[1])[0][0];
  const expression = rawExpr.charAt(0).toUpperCase() + rawExpr.slice(1);

  // Identity — compare descriptor against all enrolled + auto-learned
  let identity   = 'unknown';
  let confidence = 0;

  const allRefs = [...enrolledDescriptors, ...autoDescriptors];
  if (allRefs.length > 0) {
    const distances = allRefs.map(ref =>
      faceapi.euclideanDistance(detection.descriptor, ref)
    );
    const best = Math.min(...distances);
    if (best < MATCH_THRESHOLD) {
      identity   = enrolledLabel;
      confidence = Math.round((1 - best / MATCH_THRESHOLD) * 100); // 0–100%

      // Auto-enroll: if high confidence and we have room, learn this frame
      if (confidence >= AUTOENROLL_THRESHOLD && autoDescriptors.length < AUTOENROLL_MAX) {
        autoDescriptors.push(detection.descriptor);
        console.log(`[FaceID] Auto-enrolled live frame — confidence ${confidence}% (${autoDescriptors.length}/${AUTOENROLL_MAX} learned)`);
      }
    }
  }

  return { present: true, identity, confidence, expression };
}

export function getFaceIdStatus() {
  return {
    modelsLoaded,
    enrolledLabel,
    enrolledCount: enrolledDescriptors.length,
    autoEnrolledCount: autoDescriptors.length,
    threshold: MATCH_THRESHOLD,
    autoEnrollThreshold: AUTOENROLL_THRESHOLD,
  };
}
