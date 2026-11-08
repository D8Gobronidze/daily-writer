// Gemini on Google's free tier (a GEMINI_API_KEY from aistudio.google.com, no card).
// Asks for JSON matching a schema; uses the Interactions API and falls back to generateContent.
export const MODEL = 'gemini-3.8-flash'; // free-tier model; change here if Google retires it
// Other free-tier models, tried in turn when the main one stays overloaded (503) or has used up its
// daily free requests (429 "per day"; each model has its own allowance).
export const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
// For the small jobs (picking topics, photo searches and photos): the main model's few free daily requests
// are kept for writing the post, so it doesn't run out halfway through one.
export const LIGHT_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', MODEL];
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const WAITS = [20_000, 60_000, 120_000]; // the free tier answers 429 when busy: wait and try again
// Models out of free requests for today (429 "per day"): later calls in this run skip them.
const spentToday = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `busyWaits`: the waits for an overloaded model (503/500); shorter when another model can take over.
async function post(path, body, { key, fetchFn, waits, busyWaits = waits }) {
  let busy = 0;
  for (let attempt = 0; ; attempt++) {
    let res;
    let text;
    try {
      res = await fetchFn(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (err) {
      // A dropped connection ("fetch failed") is retried like a busy server.
      if (attempt >= waits.length) throw Object.assign(err, { busy: true });
      console.log(`Connection to Gemini failed (${err.message}); waiting ${waits[attempt] / 1000}s…`);
      await sleep(waits[attempt]);
      continue;
    }
    if (res.ok) return JSON.parse(text);
    // A used-up daily allowance won't come back by waiting: let askJson switch models.
    const daily = res.status === 429 && /per day/i.test(text);
    const overloaded = res.status === 500 || res.status === 503;
    const wait = overloaded ? busyWaits[busy++] : res.status === 429 && !daily ? waits[attempt] : undefined;
    if (wait !== undefined) {
      console.log(`Gemini answered HTTP ${res.status}; waiting ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    throw Object.assign(new Error(`Gemini ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`), { status: res.status, daily, busy: [429, 500, 503].includes(res.status) });
  }
}

// Text of a finished interaction: the model_output step's text parts.
export function interactionText(data) {
  if (data.status && data.status !== 'completed') {
    throw new Error(`Gemini stopped early (${data.status}${data.errors?.length ? `: ${data.errors.map((e) => e.message).join('; ')}` : ''})`);
  }
  return (data.steps ?? [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

// Text of a generateContent answer.
export function candidateText(data) {
  const c = data.candidates?.[0];
  if (!c) throw new Error(`Gemini gave no answer${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}`);
  if (c.finishReason && c.finishReason !== 'STOP') throw new Error(`Gemini stopped early (${c.finishReason})`);
  return (c.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
}

/** Sends system + prompt (+ optional images: [{data: base64, mime}]), returns the parsed JSON object.
 *  `models`: the order to try models in (default: the main model, then the fallbacks). */
export async function askJson({ spent = spentToday, ...opts }) {
  const all = opts.model ? [opts.model] : opts.models ?? [MODEL, ...FALLBACK_MODELS];
  const models = all.filter((m) => !spent.has(m));
  if (!models.length) throw Object.assign(new Error(`Every Gemini model is out of free requests for today (${all.join(', ')})`), { busy: true });
  for (const [i, model] of models.entries()) {
    const last = i === models.length - 1;
    try {
      // While another model can take over, an overloaded one gets one short wait instead of all of them.
      return await askModel({ ...opts, model, last });
    } catch (err) {
      if (err.daily) spent.add(model);
      if (!(err.status === 503 || err.status === 500 || err.daily) || last) throw err;
      console.log(`${model} is ${err.daily ? 'out of free requests for today' : 'overloaded'}; trying ${models[i + 1]}.`);
    }
  }
}

async function askModel({ system, prompt, schema, images = [], key = process.env.GEMINI_API_KEY, fetchFn = fetch, model, last = true, waits = WAITS }) {
  if (!key) throw new Error('Set GEMINI_API_KEY');
  const opts = { key, fetchFn, waits, busyWaits: last ? waits : waits.slice(0, 1) };
  let text;
  try {
    text = interactionText(
      await post('/interactions', {
        model,
        system_instruction: system,
        input: images.length ? [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image', data: i.data, mime_type: i.mime }))] : prompt,
        response_format: { type: 'text', mime_type: 'application/json', schema },
        generation_config: { max_output_tokens: 16000, thinking_level: 'medium' },
        store: false,
      }, opts),
    );
  } catch (err) {
    // An account or region without the Interactions API: the classic endpoint does the same job.
    if (err.status !== 404 && err.status !== 400) throw err;
    console.log(`Interactions API unavailable (${err.status}); using generateContent.`);
    text = candidateText(
      await post(`/models/${model}:generateContent`, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }))] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 16000 },
      }, opts),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Gemini did not return valid JSON'), { invalidJson: true });
  }
}
