# AI_Voice_Agent

Welcome! This repository contains the blueprint and implementation for a production-ready, ultra-low latency conversational AI voice agent. We focus on a **streaming pipeline** because in voice AI, latency is the difference between a magical experience and a clunky robot.

## 1. High-Level System Architecture

To achieve human-like conversational latency (< 800ms round trip), we use WebSockets to stream data constantly. 

```mermaid
graph TD
    %% Entities
    Client[Frontend: React.js]
    Node[Backend: Node.js / Express + Socket.io]
    STT[STT: Deepgram / Whisper]
    LLM[AI Brain: OpenAI GPT-4o]
    TTS[TTS: ElevenLabs]
    DB[(Database: MongoDB)]

    %% Flow
    Client -- 1. Audio Stream (WebSockets) --> Node
    Node -- 2. Audio Stream --> STT
    STT -- 3. Transcribed Text (Stream) --> Node
    Node -- 4. Text Prompt --> LLM
    LLM -- 5. Text Tokens (Stream) --> Node
    Node -- 6. Text Tokens --> TTS
    TTS -- 7. Audio Buffer (Stream) --> Node
    Node -- 8. Audio Stream --> Client
    Node -. 9. Save Conversation State .-> DB

    style Client fill:#61dafb,stroke:#333,stroke-width:2px,color:#000
    style Node fill:#8cc84b,stroke:#333,stroke-width:2px,color:#000
    style STT fill:#f9a826,stroke:#333,stroke-width:2px,color:#000
    style LLM fill:#10a37f,stroke:#333,stroke-width:2px,color:#fff
    style TTS fill:#000000,stroke:#333,stroke-width:2px,color:#fff
```

### Trade-offs & Tech Selection:
*   **Backend**: Node.js is perfect for handling asynchronous I/O and WebSocket streams.
*   **STT**: While OpenAI's Whisper is great for batch processing, its latency is too high for real-time without specific architectures. **Recommendation: Deepgram**. It provides <300ms real-time streaming STT.
*   **LLM**: OpenAI GPT-4o or GPT-4o-mini. They offer the best instruction following and rapid token streaming.
*   **TTS**: **ElevenLabs** for the most human-like voices, utilizing their WebSocket API for text-to-audio streaming.
*   **Transport**: WebSockets (Socket.io). WebRTC is better for raw UDP audio but is complex to set up. WebSockets are sufficient for most Web/App products.

---

## 2. Step-by-Step Implementation Roadmap

*   **Phase 1: Project Setup & Audio Pipeline**
    *   Set up Node.js/Express server and React frontend.
    *   Establish Socket.io connection.
    *   Capture microphone audio in React and stream to backend.
*   **Phase 2: STT Integration**
    *   Pipe incoming audio stream from frontend to Deepgram WebSocket.
    *   Return real-time text transcripts back to the frontend.
*   **Phase 3: The AI Brain**
    *   Send final transcripts to OpenAI.
    *   Stream the LLM response back token-by-token.
    *   Implement context management (store conversation history).
*   **Phase 4: TTS & Playback**
    *   Pipe LLM text tokens directly into ElevenLabs WebSocket.
    *   Stream audio buffers back to the frontend.
    *   Queue and play audio chunks continuously on the client.
*   **Phase 5: Interruption (Barge-in) & Polish**
    *   Implement logic to halt LLM/TTS generation if the user starts speaking over the bot.
    *   Add Echo Cancellation to the frontend microphone.

---

## 3. Core Implementation Code Concepts

Here are the production-level building blocks for the backend.

### A. The Orchestrator (Node.js + Socket.io)
This is where the magic happens. We listen for audio, transcribe it, generate a response, and speak it.

```javascript
// server.js (Conceptual Outline)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // 1. Initialize STT Stream
    let sttConnection = setupSTT((finalText) => {
        // 2. Transcribed text received. Send to LLM.
        const textStream = generateResponseStream(finalText);
        
        // 3. Pipe text stream to TTS
        const audioStream = streamTTS(textStream);
        
        // 4. Send audio back to client
        audioStream.on('data', chunk => socket.emit('audio_chunk', chunk));
    });

    socket.on('audio_stream', (data) => sttConnection.send(data));
    socket.on('stop_speaking', () => { /* Handle user interruption */ });
});

server.listen(3001, () => console.log('Voice AI Server running'));
```

### B. STT: Real-Time Transcription (Deepgram)
*Why Deepgram?* It is the industry standard for real-time voice agents due to <300ms latency.

```javascript
// services/stt.js
const { createClient } = require('@deepgram/sdk');
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

function setupSTT(onFinal) {
    const connection = deepgram.listen.live({
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        endpointing: 300, // Detect end of speech after 300ms of silence
    });

    connection.on('Results', (data) => {
        if (data.is_final) onFinal(data.channel.alternatives[0].transcript);
    });
    
    return connection;
}
```

### C. AI Brain: LLM Streaming (OpenAI)
*Pro-tip:* Stream the text. Don't wait for the full sentence to finish generating before sending to TTS.

```javascript
// services/llm.js
const { OpenAI } = require('openai');
const openai = new OpenAI();

async function* generateResponseStream(userInput) {
    const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: userInput }],
        stream: true,
    });

    for await (const chunk of stream) {
        yield chunk.choices[0]?.delta?.content || ''; 
    }
}
```

### D. TTS: Voice Generation (ElevenLabs)
*Pro-tip:* We use the ElevenLabs input streaming API so we can send partial text chunks as they arrive from OpenAI.

```javascript
// services/tts.js
const WebSocket = require('ws');
const { PassThrough } = require('stream');

function streamTTS(textStream) {
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/VOICE_ID/stream-input`);
    const outputAudioStream = new PassThrough();

    ws.on('open', async () => {
        ws.send(JSON.stringify({ text: " ", xi_api_key: process.env.ELEVENLABS_API_KEY }));
        for await (const textChunk of textStream) {
            ws.send(JSON.stringify({ text: textChunk, try_trigger_generation: true }));
        }
        ws.send(JSON.stringify({ text: "" })); // End of stream
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        if (response.audio) outputAudioStream.write(Buffer.from(response.audio, 'base64'));
    });

    return outputAudioStream;
}
```

---

## 4. Optimization Techniques (The "Secret Sauce")

To make this feel like a real product rather than a weekend project, you must implement these optimizations:

### A. Reducing Latency (Time to First Byte - TTFB)
1. **Sentence Boundary Detection**: Buffer the LLM tokens and send text to the TTS engine whenever the LLM outputs a punctuation mark (`.`, `?`, `!`, `,`). This allows the TTS to start generating audio for the first sentence while the LLM is still writing the second.
2. **Region Co-location**: Host your Node server in `us-east` if you are using OpenAI and ElevenLabs, as their primary servers are often located there.

### B. Interruption Handling (Barge-in)
When the AI is speaking, the user might interrupt. 
*   **Frontend**: Continuously run a lightweight VAD (Voice Activity Detection) in the browser.
*   **Event**: If user speech > 500ms is detected while AI is playing audio, frontend sends a `STOP` signal.
*   **Backend Action**: Instantly terminate the OpenAI stream and ElevenLabs WebSocket. Send a signal to the frontend to flush the audio playback buffer.

### C. Prompt Engineering for Voice
Voice is different from chat. Users hate listening to long lists.
*   *System Prompt Injection:* "Never use markdown, asterisks, or lists. Respond in short, conversational paragraphs. Speak exactly as a human would."

---

## 5. Common Bugs & Debugging Strategies

| Problem | Cause | Solution |
| :--- | :--- | :--- |
| **The Bot hears its own voice (Echo)** | Speakers playing into the mic | Enable `echoCancellation: true` in `navigator.mediaDevices.getUserMedia()`. |
| **Audio sounds robotic / glitchy** | Buffer underrun. | Add a **Jitter Buffer** on the frontend. Wait to accumulate ~200ms of audio before starting playback. |
| **Bot interrupts itself** | VAD endpointing too aggressive | Increase the STT silence endpointing duration (e.g., to 500ms or 800ms). |

---

## 6. Deployment Guide

Since this relies heavily on WebSockets, Serverless architectures (like AWS Lambda) **will not work well**.

### Recommended Production Stack
1.  **Backend (Node.js)**: **Render.com** (Web Service), **Railway.app**, or **Fly.io** (excellent for globally distributed low-latency WebSockets).
2.  **Frontend (React)**: **Vercel** or **Netlify**.
3.  **Database**: **MongoDB Atlas** (Free Tier is perfectly fine to store conversation transcripts).