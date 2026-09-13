const https = require('https');
const http = require('http');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQbnna-vcEFstuBQvVLP1bFLEveKMrJ1DAeWzVjHKi_WAJnDvJzg4KTlWWYNOcc8hffAayMBLYgYLoR/pub?gid=0&single=true&output=csv';

const conversations = {};

function fetchRates() {
  return new Promise((resolve) => {
    https.get(GOOGLE_SHEET_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const rates = {};
        const lines = data.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols[2] && cols[2].trim()) {
            const cur = cols[2].trim().toUpperCase();
            rates[cur] = { buy: parseFloat(cols[3]) || 0, sell: parseFloat(cols[4]) || 0 };
          }
        }
        resolve(rates);
      });
    }).on('error', () => resolve({}));
  });
}

function callClaude(messages, system) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: system,
      messages: messages
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.content && result.content[0] ? result.content[0].text : '{}');
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendChatwootMessage(conversationId, content, isPrivate) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      content: content,
      message_type: 'outgoing',
      private: isPrivate
    });

    const options = {
      hostname: CHATWOOT_URL,
      path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages',
      method: 'POST',
      headers: {
        'api_access_token': CHATWOOT_TOKEN,
        'Content-Type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      res.on('data', function() {});
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async function(req, res) {
  // Log ALL incoming requests
  console.log('Request received:', req.method, req.url);

  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      res.writeHead(200);
      res.end('OK');

      console.log('Webhook received, body length:', body.length);

      try {
        const payload = JSON.parse(body);
        console.log('Event:', payload.event, 'Type:', payload.message_type);

        if (payload.event !== 'message_created' || payload.message_type !== 'incoming') {
          console.log('Skipping - not incoming message');
          return;
        }

        const currentMessage = String(payload.content || '').trim();
        const conversationId = payload.conversation && payload.conversation.id;
        const senderName = String((payload.sender && payload.sender.name) || 'friend').replace(/[\n\r"\\]/g, ' ');
        const customerId = String((payload.sender && payload.sender.id) || conversationId);

        console.log('Processing message:', currentMessage, 'from:', senderName);

        if (!currentMessage || !conversationId) return;

        if (!conversations[customerId]) conversations[customerId] = [];
        const history = conversations[customerId];

        const rates = await fetchRates();
        const ratesText = Object.entries(rates).map(function(entry) {
          return entry[0] + ' buy:' + entry[1].buy + ' sell:' + entry[1].sell;
        }).join(' | ');

        const messages = history.slice();
        messages.push({
          role: 'user',
          content: '[rates:' + ratesText + '] [name:' + senderName + '] ' + currentMessage
        });

        const system = 'You are Hassan, warm and friendly forex assistant at AfriDesk East Africa. Use customer name naturally. Build rapport. Use conversation history fully - never ask for info already given. If customer sends a number after discussing a currency calculate immediately. Reply naturally in customer language. Calculate KES using rates in [rates:...]. VIP: amount >= 5000 USD or competitor offer or urgency = is_vip true, tell teller will contact. Return ONLY valid JSON: {"intent":"","direction":"buy|sell|null","currency":"ISO or null","amount":null,"is_vip":false,"reply":"your natural response"}';

        const claudeText = await callClaude(messages, system);
        console.log('Claude response received');
        const clean = claudeText.replace(/```json|```/g, '').trim();

        let aiData = {};
        try {
          aiData = JSON.parse(clean);
        } catch(e) {
          console.log('JSON parse error:', e.message, 'Text:', clean.substring(0, 100));
          aiData = { reply: "I'm here to help! How can I assist you with forex today?", is_vip: false };
        }

        const reply = aiData.reply || "I'm here to help!";
        const isVip = aiData.is_vip || false;

        history.push({ role: 'user', content: currentMessage });
        history.push({ role: 'assistant', content: reply });
        if (history.length > 20) conversations[customerId] = history.slice(-20);

        if (isVip) {
          const tellerNote = '🚨 VIP ENQUIRY\n👤 ' + senderName + '\n💱 ' + (aiData.currency || '?') + '\n💰 ' + (aiData.amount ? Number(aiData.amount).toLocaleString() : '?') + '\n📝 "' + currentMessage + '"\n✅ Contact customer for preferential rate.';
          await sendChatwootMessage(conversationId, tellerNote, true);
        }

        await sendChatwootMessage(conversationId, reply, false);
        console.log('Reply sent successfully');

      } catch(err) {
        console.error('Error:', err.message);
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('AfriDesk API Running!');
  } else {
    res.writeHead(200);
    res.end('OK');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('AfriDesk API running on port ' + PORT);
});
