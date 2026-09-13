const https = require('https');
const http = require('http');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQbnna-vcEFstuBQvVLP1bFLEveKMrJ1DAeWzVjHKi_WAJnDvJzg4KTlWWYNOcc8hffAayMBLYgYLoR/pub?gid=0&single=true&output=csv';

const conversations = {};

function fetchRates() {
  return new Promise(function(resolve) {
    https.get(GOOGLE_SHEET_URL, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        var rates = {};
        var lines = data.trim().split('\n');
        for (var i = 1; i < lines.length; i++) {
          var cols = lines[i].split(',');
          if (cols[2] && cols[2].trim()) {
            var cur = cols[2].trim().toUpperCase();
            rates[cur] = { buy: parseFloat(cols[3]) || 0, sell: parseFloat(cols[4]) || 0 };
          }
        }
        resolve(rates);
      });
    }).on('error', function() { resolve({}); });
  });
}

function callClaude(messages, system) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: system,
      messages: messages
    });

    var options = {
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

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var result = JSON.parse(data);
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
  return new Promise(function(resolve) {
    var body = JSON.stringify({
      content: content,
      message_type: 'outgoing',
      private: isPrivate
    });

    var options = {
      hostname: CHATWOOT_URL,
      path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages',
      method: 'POST',
      headers: {
        'api_access_token': CHATWOOT_TOKEN,
        'Content-Type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function(res) {
      res.on('data', function() {});
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

var server = http.createServer(function(req, res) {
  console.log('Request:', req.method, req.url);

  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      res.writeHead(200);
      res.end('OK');

      try {
        var payload = JSON.parse(body);

        if (payload.event !== 'message_created' || payload.message_type !== 'incoming') return;

        var currentMessage = String(payload.content || '').trim();
        var conversationId = payload.conversation && payload.conversation.id;
        var senderName = String((payload.sender && payload.sender.name) || 'friend').replace(/[\n\r"\\]/g, ' ');
        var customerId = String((payload.sender && payload.sender.id) || conversationId);

        if (!currentMessage || !conversationId) return;

        if (!conversations[customerId]) conversations[customerId] = [];
        var history = conversations[customerId];

        var rates = await fetchRates();
        var ratesText = Object.entries(rates).map(function(e) {
          return e[0] + ' buy:' + e[1].buy + ' sell:' + e[1].sell;
        }).join(' | ');

        var messages = history.slice();
        messages.push({
          role: 'user',
          content: '[rates:' + ratesText + '] [name:' + senderName + '] [today:' + new Date().toDateString() + '] ' + currentMessage
        });

        var system = 'You are Hassan, warm friendly forex assistant at AfriDesk East Africa. Use customer name naturally. Build rapport. Use full conversation history - never ask for info already given. RATES: Live rates are in [rates:...] in every message - always use them, never say you dont have rates. ASSUMPTION: If customer says they HAVE a foreign currency they want to SELL it for KES - calculate immediately. If no amount given ask only for amount. Reply in customer language. Today is in [today:...]. VIP: amount >= 5000 USD equivalent or competitor offer = is_vip true, tell teller will contact with preferential rate. CRITICAL: ALWAYS return ONLY valid JSON starting with { and ending with }. Never plain text. Return: {"intent":"","direction":"buy|sell|null","currency":"ISO or null","amount":null,"is_vip":false,"reply":"your natural response"}';

        var claudeText = await callClaude(messages, system);
        console.log('Claude raw:', claudeText.substring(0, 100));

        var clean = claudeText.replace(/```json|```/g, '').trim();

        var aiData = {};
        try {
          aiData = JSON.parse(clean);
        } catch(e) {
          console.log('JSON error, using fallback. Raw:', clean.substring(0, 50));
          aiData = { reply: clean.length > 0 && clean.length < 500 ? clean : "I'm here to help with forex!", is_vip: false };
        }

        var reply = aiData.reply || "How can I help you with forex today?";
        var isVip = aiData.is_vip || false;

        history.push({ role: 'user', content: currentMessage });
        history.push({ role: 'assistant', content: reply });
        if (history.length > 20) conversations[customerId] = history.slice(-20);

        if (isVip) {
          var tellerNote = '🚨 VIP ENQUIRY\n👤 ' + senderName + '\n💱 ' + (aiData.currency || '?') + '\n💰 ' + (aiData.amount ? Number(aiData.amount).toLocaleString() : '?') + '\n📝 "' + currentMessage + '"\n✅ Contact customer for preferential rate.';
          await sendChatwootMessage(conversationId, tellerNote, true);
        }

        await sendChatwootMessage(conversationId, reply, false);
        console.log('Reply sent:', reply.substring(0, 50));

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

var PORT = process.env.PORT || 3000;
server.listen(PORT, function() {
  console.log('AfriDesk API running on port ' + PORT);
});
