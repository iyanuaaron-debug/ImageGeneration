const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ---------------- ENV ----------------
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

if (!WAVESPEED_API_KEY) throw new Error('WAVESPEED_API_KEY missing');
if (!FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID missing');
if (!FIREBASE_CLIENT_EMAIL) throw new Error('FIREBASE_CLIENT_EMAIL missing');
if (!FIREBASE_PRIVATE_KEY) throw new Error('FIREBASE_PRIVATE_KEY missing');

// ---------------- JWT / FIREBASE AUTH ----------------
function str2ab(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\\n/g, '')
    .replace(/[\r\n\s]/g, '');

  const binary = atob(clean);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

async function getAccessToken() {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: FIREBASE_CLIENT_EMAIL,
    sub: FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
    scope: 'https://www.googleapis.com/auth/datastore',
  };

  function base64url(obj) {
    return btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    str2ab(FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const jwt = `${signingInput}.${sigB64}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get Firebase access token');
  return data.access_token;
}

// ---------------- FIRESTORE MERGE UPDATE ----------------
// Updates nested day fields e.g. Sunday.BreakfastImage
async function firestoreMergeUpdate(docPath, data, token) {
  const fieldPaths = [];
  const nestedFields = {};

  for (const dayKey of Object.keys(data)) {
    const dayData = data[dayKey];
    const dayFields = {};
    for (const fieldKey of Object.keys(dayData)) {
      const path = `${dayKey}.${fieldKey}`;
      fieldPaths.push(path);

      const val = dayData[fieldKey];
      if (Array.isArray(val)) {
        dayFields[fieldKey] = {
          arrayValue: { values: val.map((v) => ({ stringValue: v })) },
        };
      } else {
        dayFields[fieldKey] = { stringValue: val };
      }
    }
    nestedFields[dayKey] = { mapValue: { fields: dayFields } };
  }

  const maskParams = fieldPaths
    .map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`)
    .join('&');

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}?${maskParams}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: nestedFields }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore update failed: ${err}`);
  }
}

// ---------------- FIRESTORE FLAT UPDATE ----------------
// Updates top-level fields on a document e.g. status: 'completed'
async function firestoreFlatUpdate(docPath, data, token) {
  const fieldPaths = Object.keys(data).join('&updateMask.fieldPaths=');
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}?updateMask.fieldPaths=${fieldPaths}`;

  const fields = {};
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (typeof val === 'string') fields[key] = { stringValue: val };
    else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
    else if (typeof val === 'number') fields[key] = { doubleValue: val };
    else fields[key] = { stringValue: String(val) };
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore flat update failed: ${err}`);
  }
}

// ---------------- WAVESPEED ----------------
async function generateWaveSpeedImage(prompt) {

  // ✅ prompt is passed explicitly as a parameter to avoid closure issues
  async function submitTask(promptText) {
    const res = await fetch(
      'https://api.wavespeed.ai/api/v3/openai/gpt-image-1.5/text-to-image',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WAVESPEED_API_KEY}`,
        },
        body: JSON.stringify({
          enable_base64_output: false,
          enable_sync_mode: false,
          output_format: 'jpeg',
          prompt: promptText, // ✅ explicitly passed, no closure dependency
          quality: 'low',
          size: '1024*1024',
        }),
      }
    );

    const rawText = await res.text();
    console.log('📡 WaveSpeed raw response:', rawText);
    const json = JSON.parse(rawText);

    if (!res.ok || !json.data?.id || !json.data?.urls?.get) {
      throw new Error(`WaveSpeed submit failed: ${rawText}`);
    }
    return json.data;
  }

  async function pollResult(pollUrl, maxAttempts = 25) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));

      const res = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` },
      });

      const json = JSON.parse(await res.text());
      const status = json.data?.status || json.status;

      if (status === 'completed') return json.data?.outputs?.[0] || null;
      if (status === 'failed') return null;
    }
    return null;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await submitTask(prompt); // ✅ pass prompt explicitly
      const imageUrl = await pollResult(data.urls.get);
      if (imageUrl) return imageUrl;
    } catch (err) {
      console.error(`❌ WaveSpeed attempt ${attempt} failed:`, err.message);
    }
  }

  return null;
}

// ---------------- MEAL IMAGE LOGIC ----------------
async function generateMealImagesAndUpdate(timetableId, day, mealKey, promptsForMeal, token) {
  console.log(`⏳ Generating images for ${day} ${mealKey}...`);

  let mealImage = null;
  const instructionImages = [];

  for (const promptObj of promptsForMeal) {
    const imageUrl = await generateWaveSpeedImage(promptObj.prompt);
    if (!imageUrl) continue;

    if (promptObj.key.endsWith('Meal')) {
      mealImage = imageUrl;
    } else {
      instructionImages.push(imageUrl);
    }
  }

  const updatePayload = {};

  if (mealKey === 'Breakfast') {
    if (mealImage) updatePayload.BreakfastImage = mealImage;
    if (instructionImages.length) updatePayload.BreakFastInstructionImages = instructionImages;
  }

  if (mealKey === 'Lunch') {
    if (mealImage) updatePayload.LunchImage = mealImage;
    if (instructionImages.length) updatePayload.LunchInstructionImages = instructionImages;
  }

  if (mealKey === 'Dinner') {
    if (mealImage) updatePayload.DinnerImage = mealImage;
    if (instructionImages.length) updatePayload.DinnerInstructionImages = instructionImages;
  }

  if (Object.keys(updatePayload).length === 0) {
    console.log(`⚠️ No images generated for ${day} ${mealKey}, skipping update`);
    return;
  }

  await firestoreMergeUpdate(`Timetable/${timetableId}`, { [day]: updatePayload }, token);
  console.log(`✅ Firestore updated for ${day} ${mealKey}`);
}

// ---------------- ROUTE ----------------
app.post('/generate-week-images', async (req, res) => {
  const { timetableId, promptsByDay } = req.body;

  if (!timetableId || !promptsByDay) {
    return res.status(400).json({ error: 'timetableId and promptsByDay required' });
  }

  res.json({ message: 'Image generation started', timetableId });

  (async () => {
    try {
      const token = await getAccessToken();

      // Generate images for all days and meals
      for (const day of Object.keys(promptsByDay)) {
        const meals = promptsByDay[day];
        for (const mealKey of Object.keys(meals)) {
          await generateMealImagesAndUpdate(
            timetableId,
            day,
            mealKey,
            meals[mealKey],
            token
          );
        }
      }

      // ✅ All images done — now mark Timetable as completed
      await firestoreFlatUpdate(
        `Timetable/${timetableId}`,
        {
          status: 'completed',
          images_updated_at: new Date().toISOString(),
        },
        token
      );

      console.log(`✅ All images processed and status set to completed for timetable: ${timetableId}`);
    } catch (err) {
      console.error('❌ Image generation failed:', err.message);
    }
  })();
});

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------------- START ----------------
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🖼️ WaveSpeed worker running on port ${PORT}`)
);
