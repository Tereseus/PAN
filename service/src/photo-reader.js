// The photo reader (steward service "photo-reader", :7787): the camera's describing model (moondream
// on the hub), from the files Ollama holds, run by the llama-server Ollama ships on this machine's
// graphics chip through the Vulkan backend Ollama also ships. Turned on by the photo_reader setting.
// Hub, Ryzen 7 5800H with its AMD iGPU, 2026-11-08: a new photo took 5.1 s there against 7.5 to
// 8.3 s in Ollama on the CPU, with the same descriptions (32 of 32 runs). The voice model gained
// nothing on the same chip (it read 271 and wrote 31 tokens a second either way), so only photos
// go there. analyzeImage (llm.js) asks here first and falls back to Ollama. See docs/FEATURES.md.
export const PHOTO_READER_PORT = 7787;

// Ollama's moondream template and stop words (its Modelfile), with the image first.
const question = (marker, prompt) => `${marker} Question: ${prompt}\n\n Answer:`;
const STOP = ['<|endoftext|>', 'Question:'];

const bare = (name) => String(name || '').trim().replace(/:latest$/, '');

/** The two files of a model that sees, from Ollama's /api/show modelfile: the language model
 *  first, then the image projector. Null when it has no projector. */
export function modelFiles(modelfile) {
  const from = [...String(modelfile || '').matchAll(/^FROM (.+)$/gm)].map((m) => m[1].trim());
  return from.length >= 2 ? { file: from[0], projector: from[1] } : null;
}

/** How the steward starts it. Every layer on the graphics chip (-ngl 99); 4 threads, as the CPU
 *  only cuts the photo up. -c 2048 is all moondream was trained on (a photo is 729 tokens). The
 *  alias is how a caller knows which model this is. -lv 3 logs the layers it put on the chip. */
export function photoReaderArgs({ file, projector, model, port = PHOTO_READER_PORT }) {
  return ['--model', file, '--mmproj', projector, '--alias', model, '--port', String(port), '--host', '127.0.0.1',
    '-c', '2048', '-t', '4', '-ngl', '99', '-np', '1', '--no-webui', '-lv', '3'];
}

/**
 * Describes a photo on the photo reader. Null when none serves `model` (none running, or one
 * running another model), so the caller goes to Ollama at once; throws when it fails part way.
 * The image marker is asked for each time, as llama-server picks a random one at every start.
 */
export async function describeWithPhotoReader(prompt, imageBase64, { model, maxTokens = 300, timeoutMs = 20_000, port = PHOTO_READER_PORT } = {}) {
  const base = `http://127.0.0.1:${port}`;
  let props;
  try {
    const r = await fetch(`${base}/props`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    props = await r.json();
  } catch {
    return null;
  }
  if (!props?.modalities?.vision || !props.media_marker) return null;
  if (bare(props.model_alias) !== bare(model)) return null;
  const r = await fetch(`${base}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: { prompt_string: question(props.media_marker, prompt), multimodal_data: [imageBase64] },
      n_predict: maxTokens,
      temperature: 0,
      stop: STOP,
      cache_prompt: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`photo reader ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  return { text: String(j.content || '').trim(), input_tokens: j.timings?.prompt_n || 0, output_tokens: j.timings?.predicted_n || 0 };
}
