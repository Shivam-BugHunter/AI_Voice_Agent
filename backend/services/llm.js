/**
 * LLM Service - OpenAI GPT Streaming
 * 
 * Streams tokens from OpenAI's chat completion API.
 * Uses an async generator so the TTS service can start speaking
 * the first sentence while the LLM is still generating the rest.
 * 
 * KEY OPTIMIZATION: System prompt is tuned for voice output —
 * short, natural sentences without markdown formatting.
 */
const { OpenAI } = require('openai');

// Use Groq if available, otherwise fallback to OpenAI
const isUsingGroq = !!process.env.GROQ_API_KEY;
const openai = new OpenAI({
  apiKey: isUsingGroq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY,
  baseURL: isUsingGroq ? 'https://api.groq.com/openai/v1' : undefined,
});

console.log(`[LLM] 🤖 Using ${isUsingGroq ? 'Groq (Llama-3)' : 'OpenAI (GPT-4o)'} for responses`);

const SYSTEM_PROMPT = `You are a friendly, intelligent voice assistant. You must follow these rules strictly:
1. Keep responses concise — ideally 1-3 short sentences.
2. NEVER use markdown, asterisks, bullet points, numbered lists, or any text formatting.
3. Speak naturally as a human would in a conversation.
4. If the user asks a complex question, give the most important point first, then offer to elaborate.
5. Use contractions (I'm, you're, don't) to sound natural.
6. End with a brief question or acknowledgment when appropriate to keep the conversation flowing.`;

// Per-session conversation history management
class ConversationManager {
  constructor() {
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.maxTurns = 20; // Keep last 20 exchanges to avoid token overflow
  }

  addUser(text) {
    this.history.push({ role: 'user', content: text });
    this._trim();
  }

  addAssistant(text) {
    this.history.push({ role: 'assistant', content: text });
    this._trim();
  }

  getMessages() {
    return [...this.history];
  }

  _trim() {
    // Always keep system prompt + last N messages
    if (this.history.length > this.maxTurns + 1) {
      this.history = [
        this.history[0], // system prompt
        ...this.history.slice(-(this.maxTurns)),
      ];
    }
  }
}

/**
 * Streams the LLM response token-by-token.
 * Returns an object with:
 *   - stream: AsyncGenerator yielding text chunks
 *   - abort(): function to cancel the stream (for barge-in)
 */
async function generateResponseStream(conversation, userInput) {
  conversation.addUser(userInput);

  const controller = new AbortController();

  const stream = await openai.chat.completions.create(
    {
      model: isUsingGroq ? 'llama-3.1-8b-instant' : 'gpt-4o-mini', 
      messages: conversation.getMessages(),
      stream: true,
      max_tokens: 200, // Keep voice responses short
    },
    { signal: controller.signal }
  );

  async function* tokenGenerator() {
    let fullResponse = '';
    try {
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          fullResponse += text;
          yield text;
        }
      }
      // Save the full response to conversation history
      conversation.addAssistant(fullResponse);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[LLM] ❌ Stream error:', err.message);
      }
      // Still save what we got if anything
      if (fullResponse) {
        conversation.addAssistant(fullResponse);
      }
    }
  }

  return {
    stream: tokenGenerator(),
    abort: () => controller.abort(),
  };
}

module.exports = { generateResponseStream, ConversationManager };
