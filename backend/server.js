/**
 * AI Voice Agent — Backend Orchestrator
 * 
 * This is the central hub that wires together:
 *   1. Frontend ↔ Backend (Socket.io)
 *   2. Audio → STT (Deepgram WebSocket)
 *   3. Text → LLM (OpenAI Streaming)
 *   4. Text → TTS (ElevenLabs WebSocket)
 *   5. Audio → Frontend (Socket.io)
 * 
 * Each client connection gets its own independent pipeline and conversation state.
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const { setupSTT } = require('./services/stt');
const { generateResponseStream, ConversationManager } = require('./services/llm');
const { streamTTS } = require('./services/tts');

const app = express();
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      deepgram: !!process.env.DEEPGRAM_API_KEY && process.env.DEEPGRAM_API_KEY !== 'your_deepgram_api_key_here',
      openai: !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here',
      groq: !!process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here',
      elevenlabs: !!process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here',
      tts_provider: 'Deepgram (Aura)',
    }
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://ai-voice-agent-emtt21m0g-shivam-bughunters-projects.vercel.app/',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e6, // 1MB max for audio chunks
});

io.on('connection', (socket) => {
  console.log(`\n[Socket] ✅ Client connected: ${socket.id}`);

  // ===== Per-client state =====
  const conversation = new ConversationManager();
  let sttConnection = null;
  let currentLLMAbort = null;   // Function to abort current LLM stream
  let currentTTSEmitter = null; // Current TTS emitter for abort
  let isProcessing = false;     // Prevent overlapping responses
  let finalTranscriptBuffer = ''; // Accumulate final transcripts into a complete utterance

  // Timer to detect when user has finished speaking (silence timeout)
  let utteranceTimer = null;
  const UTTERANCE_SILENCE_MS = 1500;
  let lastProcessedUtterance = '';   
  let lastProcessedTime = 0;         // Cooldown timestamp

  // ===== 1. Setup STT (with auto-reconnect) =====
  function connectSTT() {
    if (sttConnection && sttConnection.readyState <= 1) return; // Already connecting or open

    console.log(`[${socket.id}] 🎙️ Connecting to Deepgram STT...`);
    sttConnection = setupSTT(
      // On partial transcript — relay to frontend for live display
      (partialText) => {
        socket.emit('transcript_partial', partialText);
      },

      // On final transcript segment — accumulate and wait for silence
      (finalText) => {
        socket.emit('transcript_final', finalText);
        finalTranscriptBuffer += ' ' + finalText;

        // Reset the utterance timer — user is still talking
        clearTimeout(utteranceTimer);
        utteranceTimer = setTimeout(() => {
          const fullUtterance = finalTranscriptBuffer.trim();
          finalTranscriptBuffer = '';
          
          // Normalize for comparison (lowercase, remove punctuation)
          const normalized = fullUtterance.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "").trim();
          const now = Date.now();

          if (normalized && normalized !== lastProcessedUtterance && (now - lastProcessedTime > 2000)) {
            lastProcessedUtterance = normalized;
            lastProcessedTime = now;
            processUtterance(fullUtterance);
          }
        }, UTTERANCE_SILENCE_MS);
      },

      // On STT error
      (err) => {
        console.error(`[${socket.id}] ❌ STT Error:`, err.message);
        socket.emit('error', { message: 'Speech recognition error', detail: err.message });
      }
    );
  }

  // Initial connection
  connectSTT();

  // ===== 2. Process full utterance through LLM → TTS =====
  async function processUtterance(text) {
    if (isProcessing) {
      console.log(`[${socket.id}] ⏳ Already processing, queuing...`);
      return;
    }
    isProcessing = true;
    console.log(`\n[${socket.id}] 🧠 Processing: "${text}"`);
    socket.emit('agent_thinking', true);

    try {
      // Get streaming LLM response
      const { stream: textStream, abort: abortLLM } = await generateResponseStream(conversation, text);
      currentLLMAbort = abortLLM;

      // Pipe LLM tokens → TTS
      const ttsEmitter = streamTTS(textStream);
      currentTTSEmitter = ttsEmitter;

      // Relay text tokens to frontend for display
      ttsEmitter.on('text', (chunk) => {
        socket.emit('agent_text', chunk);
      });

      // Relay audio chunks to frontend for playback
      ttsEmitter.on('audio', (audioBuffer) => {
        socket.emit('agent_audio', audioBuffer);
      });

      ttsEmitter.on('done', () => {
        console.log(`[${socket.id}] ✅ Response complete`);
        socket.emit('agent_done');
        isProcessing = false;
        currentLLMAbort = null;
        currentTTSEmitter = null;
      });

      ttsEmitter.on('error', (err) => {
        console.error(`[${socket.id}] ❌ TTS error:`, err.message);
        socket.emit('agent_done');
        isProcessing = false;
      });

    } catch (err) {
      console.error(`[${socket.id}] ❌ Processing error:`, err.message);
      socket.emit('error', { message: 'Failed to generate response' });
      socket.emit('agent_done');
      isProcessing = false;
    }
  }

  // ===== 3. Receive audio from frontend =====
  socket.on('audio_stream', (data) => {
    // Ensure STT is connected
    if (!sttConnection || sttConnection.readyState > 1) {
      connectSTT();
    }

    if (sttConnection && sttConnection.readyState === 1 /* WebSocket.OPEN */) {
      sttConnection.send(data);
    } else {
      // Optional: buffer or log if STT is still connecting
      // console.log(`[${socket.id}] ⏳ STT connecting, dropping chunk...`);
    }
  });

  // ===== 4. Barge-in: User interrupts the bot =====
  socket.on('stop_agent', () => {
    console.log(`[${socket.id}] 🛑 Barge-in! Stopping agent.`);
    if (currentLLMAbort) currentLLMAbort();
    if (currentTTSEmitter && currentTTSEmitter.abort) currentTTSEmitter.abort();
    isProcessing = false;
    socket.emit('agent_done');
  });

  // ===== 5. Cleanup on disconnect =====
  socket.on('disconnect', () => {
    console.log(`[Socket] 🔌 Client disconnected: ${socket.id}`);
    clearTimeout(utteranceTimer);
    if (sttConnection && sttConnection.readyState === 1) {
      sttConnection.close();
    }
    if (currentLLMAbort) currentLLMAbort();
    if (currentTTSEmitter && currentTTSEmitter.abort) currentTTSEmitter.abort();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🚀 AI Voice Agent Server                ║`);
  console.log(`║  Running on http://localhost:${PORT}        ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log(`Services:`);
  console.log(`  STT  (Deepgram):    ${process.env.DEEPGRAM_API_KEY && process.env.DEEPGRAM_API_KEY !== 'your_deepgram_api_key_here' ? '✅ Configured' : '⚠️  Missing API key'}`);
  console.log(`  LLM  (OpenAI):      ${process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here' ? '✅ Configured' : '⚠️  Missing API key'}`);
  console.log(`  LLM  (Groq):        ${process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here' ? '✅ Configured (Active)' : '⚪ Optional'}`);
  console.log(`  TTS  (ElevenLabs):  ${process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here' ? '✅ Configured' : '⚠️  Missing API key'}`);
  console.log(`\nWaiting for connections...\n`);
});
