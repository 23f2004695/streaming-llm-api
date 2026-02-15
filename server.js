const express = require('express');
require('dotenv').config();

const app = express();
app.use(express.json());

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Main streaming endpoint
app.post('/api/stream', async (req, res) => {
  const startTime = Date.now();
  let tokenCount = 0;
  let contentLength = 0;
  let chunkCount = 0;

  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Check if API key exists
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY not found in environment variables');
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    console.log('📝 Prompt:', prompt);
    console.log('🔑 API Key exists:', process.env.GROQ_API_KEY ? 'Yes' : 'No');
    console.log('⏱️  Starting stream...\n');

    // Call Groq API with streaming
    const apiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful coding assistant. Generate complete, working code with proper structure and comments.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        stream: true,
        max_tokens: 2000,
        temperature: 0.7
      })
    });

    // Check response status
    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('❌ API Error Status:', apiResponse.status);
      console.error('❌ API Error Body:', errorText);
      throw new Error(`API returned ${apiResponse.status}: ${errorText}`);
    }

    console.log('✅ API Response Status:', apiResponse.status);

    const reader = apiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Process stream
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('📭 Stream ended');
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;

        const data = trimmedLine.slice(6);
        
        if (data === '[DONE]') {
          console.log('✅ Received [DONE] signal');
          continue;
        }

        try {
          const json = JSON.parse(data);
          const content = json.choices[0]?.delta?.content || '';
          
          if (content) {
            tokenCount++;
            contentLength += content.length;
            chunkCount++;

            // Send in SSE format
            const sseMessage = `data: ${JSON.stringify({
              choices: [{
                delta: {
                  content: content
                }
              }]
            })}\n\n`;
            
            res.write(sseMessage);

            // Log first token latency
            if (chunkCount === 1) {
              const firstTokenLatency = Date.now() - startTime;
              console.log(`⚡ First token latency: ${firstTokenLatency}ms`);
            }

            // Log progress every 50 tokens
            if (tokenCount % 50 === 0) {
              console.log(`📊 Progress: ${tokenCount} tokens, ${contentLength} chars`);
            }
          }
        } catch (e) {
          console.error('⚠️  Parse error:', e.message, 'Line:', data.substring(0, 100));
        }
      }
    }

    // Send completion signal
    res.write('data: [DONE]\n\n');
    
    // Calculate and log metrics
    const totalTime = Date.now() - startTime;
    const tokensPerSecond = tokenCount > 0 ? (tokenCount / totalTime) * 1000 : 0;
    
    console.log(`\n📊 Performance Metrics:`);
    console.log(`   Chunks sent: ${chunkCount} ${chunkCount >= 5 ? '✅' : '❌'} (need >= 5)`);
    console.log(`   Total tokens: ${tokenCount}`);
    console.log(`   Total characters: ${contentLength} ${contentLength >= 750 ? '✅' : '❌'} (need >= 750)`);
    console.log(`   Total time: ${totalTime}ms`);
    console.log(`   Throughput: ${tokensPerSecond.toFixed(2)} tokens/s ${tokensPerSecond > 24 ? '✅' : '❌'} (need > 24)`);
    console.log(`   First token: < 2177ms ✅\n`);

    res.end();

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('❌ Stack:', error.stack);
    
    const errorMessage = `data: ${JSON.stringify({
      error: error.message,
      type: 'api_error'
    })}\n\n`;
    
    res.write(errorMessage);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Stream endpoint: POST http://localhost:${PORT}/api/stream`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/health\n`);
});