import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import dotenv from "dotenv";
import { ElevenLabsClient } from 'elevenlabs';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID;
const model = 'eleven_flash_v2_5';

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

const client = new ElevenLabsClient({
  apiKey: ELEVENLABS_API_KEY,
});

async function handleChatMessage(ws, userMessage) {
  // Initialize if not present
  ws.conversationHistory ||= [];

  // Add the user's message
  ws.conversationHistory.push({
    role: 'user',
    content: userMessage,
  });

  // Call OpenAI
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        ...ws.conversationHistory,
      ],
    }),
  });

  const result = await response.json();
  console.log("openai result", result);
  const reply = result.choices[0].message;

  // Add assistant's reply to history
  ws.conversationHistory.push(reply);

  return reply.content;
}

export const createAudioStreamFromText = async (text) => {
  const audioStream = await client.textToSpeech.convertAsStream(VOICE_ID, {
    model_id: model,
    text,
    output_format: 'mp3_44100_128',
    // Optional voice settings that allow you to customize the output
    voice_settings: {
      stability: 0,
      similarity_boost: 1.0,
      use_speaker_boost: true,
      speed: 1.0,
    },
  });
  const chunks = [];
  for await (const chunk of audioStream) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  return content;
};


const setupDeepgram = (ws) => {
  const deepgram = deepgramClient.listen.live({
    smart_format: true,
    model: "nova-3",
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    console.log("deepgram: keepalive");
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram: connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, async (data) => {
      console.log("deepgram: transcript received");
      console.log("ws: transcript sent to client");
      if (data && data.channel && data.channel.alternatives[0].transcript !== "") {
        const transcript = data.channel.alternatives[0].transcript;
        console.log("Got data", transcript);

        const aiReply = await handleChatMessage(ws, transcript);

        ws.send(JSON.stringify(aiReply));

        const audioBuffer = await createAudioStreamFromText(aiReply);
        ws.send(audioBuffer, { binary: true });
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram: disconnected");
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram: metadata received");
      console.log("ws: metadata sent to client");
      ws.send(JSON.stringify({ metadata: data }));
    });
  });

  return deepgram;
};

wss.on("connection", (ws) => {
  console.log("ws: client connected");
  let deepgram = setupDeepgram(ws);

  ws.on("message", (message) => {
    console.log("ws: client data received");

    if (deepgram.getReadyState() === 1 /* OPEN */) {
      console.log("ws: data sent to deepgram");
      deepgram.send(message);
    } else if (deepgram.getReadyState() >= 2 /* 2 = CLOSING, 3 = CLOSED */) {
      console.log("ws: data couldn't be sent to deepgram");
      console.log("ws: retrying connection to deepgram");
      /* Attempt to reopen the Deepgram connection */
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(ws);
    } else {
      console.log("ws: data couldn't be sent to deepgram");
    }
  });

  ws.on("close", () => {
    console.log("ws: client disconnected");
    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('OK');
});


server.listen(process.env.PORT, () => {
  console.log("Server is listening on port ", process.env.PORT);
});
