const https = require('https');
const http = require('http');
const net = require('net');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL;
const GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQbnna-vcEFstuBQvVLP1bFLEveKMrJ1DAeWzVjHKi_WAJnDvJzg4KTlWWYNOcc8hffAayMBLYgYLoR/pub?gid=0&single=true&output=csv';

// Simple Redis client
function redisCommand(command, args) {
  return new Promise(function(resolve) {
    if (!REDIS_URL) return resolve(null);
    try {
      var url = new URL(REDIS_URL);
      var client = net.createConnection({ host: url.hostname, port: url.port || 6379 });
      var response = '';
      var parts = [command].concat(args || []);
      var cmd = '*' + parts.length + '\r\n';
      parts.forEach(function(p) {
        var s = String(p);
        cmd += '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n';
      });
      client.on('connect', function() { client.write(cmd); });
      client.on('data', function(d) {
        response += d.toString();
        if (response.includes('\r\n')) {
          client.destroy();
          var lines = response.split('\r\n');
          if (lines[0].startsWith('+') || lines[0].startsWith(':')) {
            resolve(lines[0].substring(1));
          } else if (lines[0].startsWith('$')) {
            resolve(lines[1] || null);
          } else {
            resolve(null);
          }
        }
      });
      client.on('error', function() { resolve(null); });
      setTimeout(function() { client.destroy(); resolve(null); }, 3000);
    } catch(e) { resolve(null); }
  });
}

async function getHistory(customerId) {
  try {
    var data = await redisCommand('GET', ['history:' + customerId]);
    return data ? JSON.parse(data) : [];
  } catch(e) { return []; }
}

async function saveHistory(customerId, history) {
  try {
    await redisCommand('SET', ['history:' + customerId, JSON.stringify(history)]);
    await redisCommand('EXPIRE', ['history:' + customerId, '86400']);
  } catch(e) {}
}

function fetchRates() {
  return new Promise(function(resolve) {
    https.get(GOOGLE_SHEET_URL, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        var rates = {};
        var lines = data.trim().split('\n');
        for (var i = 1; i < lines.length; i++) {
          var cols = lines[i].split(/[\t,]/);
          if (cols[2] && cols[2].trim()) {
            var cur = cols[2].trim().toUpperCase();
            rates[cur] = { buy: parseFloat(cols[3]) || 0, sell: parseFloat(cols[4]) || 0 };
          }
        }
        console.log('Rates fetched:', Object.keys(rates).join(','));
        resolve(rates);
      });
    }).on('error', function(err) {
      console.log('Rates error:', err.message);
      resolve({});
    });
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
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendChatwootMessage(conversationId, content, isPrivate) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ content: content, message_type: 'outgoing', private: isPrivate });
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

        console.log('Message from', senderName + ':', currentMessage);

        var history = await getHistory(customerId);
        var rates = await fetchRates();
        var ratesText = Object.entries(rates).map(function(e) {
          return e[0] + ':buy=' + e[1].buy + ',sell=' + e[1].sell;
        }).join(' | ');

        var messages = history.slice();
        messages.push({
          role: 'user',
          content: '[LIVE_RATES: ' + ratesText + '] [NAME: ' + senderName + '] [DATE: ' + new Date().toDateString() + '] ' + currentMessage
        });

        var system = 'You are Hassan, a warm, witty and highly intelligent forex assistant at AfriDesk East Africa.\n\nPERSONALITY:\n- Friendly, humorous, builds rapport naturally\n- Uses customer name naturally\n- References previous messages in conversation\n- Speaks customer language (English/Swahili/Sheng/Somali)\n\nCRITICAL RATE RULES:\n- Live rates are in [LIVE_RATES: ...] - ALWAYS use EXACT numbers, never estimate\n- USD buy=128.5 means 128.5 KES NOT 129 or 130\n- Never say "rates not available" - they are always in the message\n\nCRITICAL ASSUMPTION:\n- Customer says they HAVE a foreign currency = they want to SELL it for KES\n- Calculate immediately using exact rates from LIVE_RATES\n- Only ask for amount if not given\n\nCRITICAL HISTORY:\n- Read full conversation history before responding\n- Never ask for info already given\n- If customer gave currency earlier, remember it\n\nVIP RULE:\n- Amount >= 5000 USD equivalent OR competitor rate mentioned = is_vip: true\n- Tell customer teller will contact with preferential rate\n\nALWAYS return ONLY valid JSON:\n{"intent":"","direction":"buy|sell|null","currency":"ISO or null","amount":null,"is_vip":false,"reply":"your natural response"}';

        var claudeText = await callClaude(messages, system);
        console.log('Claude:', claudeText.substring(0, 80));

        var clean = claudeText.replace(/```json|```/g, '').trim();
        var aiData = {};
        try {
          aiData = JSON.parse(clean);
        } catch(e) {
          console.log('JSON error, using text as reply');
          aiData = { reply: clean.length > 10 && clean.length < 1000 ? clean : "How can I help you with forex today?", is_vip: false };
        }

        var reply = aiData.reply || "How can I help you?";
        var isVip = aiData.is_vip || false;

        history.push({ role: 'user', content: currentMessage });
        history.push({ role: 'assistant', content: reply });
        if (history.length > 20) history = history.slice(-20);
        await saveHistory(customerId, history);

        if (isVip) {
          var tellerNote = '🚨 VIP ENQUIRY\n👤 ' + senderName + '\n💱 ' + (aiData.currency || '?') + '\n💰 ' + (aiData.amount ? Number(aiData.amount).toLocaleString() : '?') + '\n📝 "' + currentMessage + '"\n✅ Contact customer for preferential rate.';
          await sendChatwootMessage(conversationId, tellerNote, true);
        }

        await sendChatwootMessage(conversationId, reply, false);
        console.log('Sent:', reply.substring(0, 50));

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
