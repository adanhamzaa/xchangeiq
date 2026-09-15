const https = require('https');
const http = require('http');
const { Client } = require('pg');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// Hardcoded fallback rates - always available
const FALLBACK_RATES = {
  USD: { buy: 128.5, sell: 130 },
  EUR: { buy: 140.2, sell: 142 },
  GBP: { buy: 162.3, sell: 164.5 },
  AED: { buy: 35, sell: 36 },
  CNY: { buy: 17.5, sell: 18.2 },
  CAD: { buy: 94.5, sell: 96 },
  AUD: { buy: 83.2, sell: 85 },
  INR: { buy: 1.52, sell: 1.6 }
};

// Simple DB pool
async function queryDB(sql, params) {
  var client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
    var result = await client.query(sql, params);
    await client.end();
    return result;
  } catch(e) {
    try { await client.end(); } catch(x) {}
    throw e;
  }
}

async function setupDB() {
  try {
    await queryDB(`
      CREATE TABLE IF NOT EXISTS rates (
        currency VARCHAR(10) PRIMARY KEY,
        buy_rate DECIMAL(10,4),
        sell_rate DECIMAL(10,4),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await queryDB(`
      CREATE TABLE IF NOT EXISTS conversations (
        customer_id VARCHAR(100) PRIMARY KEY,
        messages JSONB DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Seed rates if empty
    var existing = await queryDB('SELECT COUNT(*) as count FROM rates');
    if (parseInt(existing.rows[0].count) === 0) {
      for (var cur in FALLBACK_RATES) {
        await queryDB(
          'INSERT INTO rates (currency, buy_rate, sell_rate) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [cur, FALLBACK_RATES[cur].buy, FALLBACK_RATES[cur].sell]
        );
      }
      console.log('Seeded default rates');
    }
    console.log('Database ready!');
  } catch(e) {
    console.log('DB setup error:', e.message);
  }
}

async function getRates() {
  try {
    var result = await queryDB('SELECT currency, buy_rate, sell_rate FROM rates');
    if (result.rows.length > 0) {
      var rates = {};
      result.rows.forEach(function(row) {
        rates[row.currency] = { buy: parseFloat(row.buy_rate), sell: parseFloat(row.sell_rate) };
      });
      console.log('DB rates loaded:', Object.keys(rates).join(','));
      return rates;
    }
  } catch(e) {
    console.log('DB rates error:', e.message);
  }
  console.log('Using fallback rates');
  return FALLBACK_RATES;
}

async function getHistory(customerId) {
  try {
    var result = await queryDB('SELECT messages FROM conversations WHERE customer_id=$1', [customerId]);
    if (result.rows.length > 0) return result.rows[0].messages || [];
  } catch(e) {
    console.log('History get error:', e.message);
  }
  return [];
}

async function saveHistory(customerId, messages) {
  try {
    var recent = messages.slice(-20);
    await queryDB(
      'INSERT INTO conversations (customer_id, messages, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (customer_id) DO UPDATE SET messages=$2, updated_at=NOW()',
      [customerId, JSON.stringify(recent)]
    );
  } catch(e) {
    console.log('History save error:', e.message);
  }
}

function detectIntent(message) {
  var msg = message.toLowerCase();
  var result = { currency: null, amount: null, direction: null };

  var currencyMap = {
    'USD': ['usd', 'dollar', 'dollars', 'dola', 'doola', 'american'],
    'EUR': ['eur', 'euro', 'euros'],
    'GBP': ['gbp', 'pound', 'pounds', 'sterling', 'uk money'],
    'AED': ['aed', 'dirham', 'dirhams', 'uae'],
    'CNY': ['cny', 'yuan', 'rmb', 'china money', 'chinese', 'pesa ya china', 'lacagta china'],
    'CAD': ['cad', 'canadian dollar'],
    'AUD': ['aud', 'australian dollar'],
    'INR': ['inr', 'rupee', 'rupees', 'indian']
  };

  for (var cur in currencyMap) {
    for (var i = 0; i < currencyMap[cur].length; i++) {
      if (msg.includes(currencyMap[cur][i])) {
        result.currency = cur;
        break;
      }
    }
    if (result.currency) break;
  }

  // Amount - handle 10k, 10,000, 10000
  var kMatch = msg.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (kMatch) {
    result.amount = parseFloat(kMatch[1]) * 1000;
  } else {
    var numMatch = msg.replace(/,/g, '').match(/\b(\d{2,}(?:\.\d+)?)\b/);
    if (numMatch) result.amount = parseFloat(numMatch[1]);
  }

  // Direction
  if (msg.match(/\b(sell|selling|kuuza|nauza|i have|nina|have cny|have usd|have gbp|have eur)\b/)) {
    result.direction = 'sell';
  } else if (msg.match(/\b(buy|buying|kununua|nunua|nataka|i want|i need|need)\b/)) {
    result.direction = 'buy';
  }

  return result;
}

function callClaude(messages, system) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
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
          resolve(result.content && result.content[0] ? result.content[0].text : '');
        } catch(e) {
          resolve('');
        }
      });
    });
    req.on('error', function() { resolve(''); });
    setTimeout(function() { req.destroy(); resolve(''); }, 15000);
    req.write(body);
    req.end();
  });
}

function parseClaudeResponse(text) {
  if (!text) return null;
  // Remove markdown code blocks
  var clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // Try direct parse
  try { return JSON.parse(clean); } catch(e) {}
  // Try extract JSON object
  var match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch(e) {}
  }
  // Return text as reply
  if (clean.length > 5 && clean.length < 1000) {
    return { reply: clean, is_vip: false, intent: 'unknown' };
  }
  return null;
}

function sendChatwootMessage(conversationId, content, isPrivate) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({
      content: content,
      message_type: 'outgoing',
      private: isPrivate || false
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
    setTimeout(function() { req.destroy(); resolve(); }, 10000);
    req.write(body);
    req.end();
  });
}

var server = http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('AfriDesk API Running!');
    return;
  }

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
        var senderName = String((payload.sender && payload.sender.name) || 'friend').replace(/["\\\n\r\t]/g, ' ').trim();
        var customerId = String((payload.sender && payload.sender.id) || conversationId);

        if (!currentMessage || !conversationId) return;
        console.log('MSG from', senderName + ':', currentMessage);

        // Load rates and history in parallel
        var loaded = await Promise.all([getRates(), getHistory(customerId)]);
        var rates = loaded[0];
        var history = loaded[1];

        // Node.js detects intent and calculates
        var intent = detectIntent(currentMessage);
        var calculation = null;

        // Also check last few history messages for currency context
        if (!intent.currency && history.length > 0) {
          var recentHistory = history.slice(-4);
          for (var h = recentHistory.length - 1; h >= 0; h--) {
            if (recentHistory[h].role === 'user') {
              var histIntent = detectIntent(recentHistory[h].content);
              if (histIntent.currency) {
                intent.currency = histIntent.currency;
                if (!intent.direction) intent.direction = histIntent.direction;
                break;
              }
            }
          }
        }

        if (intent.currency && intent.amount && rates[intent.currency]) {
          var rate = rates[intent.currency];
          var dir = intent.direction || 'sell';
          var kesAmount = dir === 'sell'
            ? Math.round(intent.amount * rate.buy)
            : Math.round(intent.amount * rate.sell);
          calculation = {
            currency: intent.currency,
            amount: intent.amount,
            direction: dir,
            rate: dir === 'sell' ? rate.buy : rate.sell,
            kes: kesAmount,
            isVip: intent.amount >= 5000 && (intent.currency === 'USD' || (intent.amount * rate.buy) >= 650000)
          };
          console.log('Calc:', dir, intent.amount, intent.currency, '=', kesAmount, 'KES');
        }

        // Build rate summary
        var ratesSummary = Object.entries(rates).map(function(e) {
          return e[0] + ' buy=' + e[1].buy + ' sell=' + e[1].sell;
        }).join(', ');

        // Build Claude messages
        var claudeMessages = history.slice(-10);
        var userContent = 'Customer name: ' + senderName + '\n';
        userContent += 'Today: ' + new Date().toLocaleString('en-KE', {timeZone: 'Africa/Nairobi'}) + ' Nairobi time\n';
        userContent += 'Live rates: ' + ratesSummary + '\n';
        if (calculation) {
          userContent += 'CALCULATION RESULT: Customer wants to ' + calculation.direction + ' ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + '. Rate: ' + calculation.rate + ' KES. Total: KSh ' + calculation.kes.toLocaleString() + '. VIP: ' + calculation.isVip + '\n';
        }
        userContent += 'Customer message: ' + currentMessage;

        claudeMessages.push({ role: 'user', content: userContent });

        var system = 'You are Hassan, a warm, witty and professional customer service assistant at AfriDesk East Africa.\n\nIMPORTANT RULES:\n1. Always respond with ONLY a valid JSON object - nothing else\n2. Use the customer name naturally in conversation\n3. Reply in the same language the customer uses (English/Swahili/Sheng/Somali)\n4. Use conversation history to understand context - never ask for info already given\n5. NEVER calculate rates yourself - use CALCULATION RESULT if provided\n6. If CALCULATION RESULT is provided, share those exact numbers naturally\n7. For VIP (is shown as VIP: true), tell customer our senior teller will contact them for preferential rate\n8. Be warm, concise and natural - not robotic\n9. For small talk, keep replies short and friendly\n\nJSON FORMAT (always return this exact structure):\n{"intent":"greeting|rates|exchange|smalltalk|other","direction":"buy|sell|null","currency":"USD|EUR|GBP|AED|CNY|CAD|AUD|INR|null","amount":null,"is_vip":false,"reply":"your natural response here"}';

        var claudeRaw = await callClaude(claudeMessages, system);
        console.log('Claude raw:', claudeRaw.substring(0, 120));

        var aiData = parseClaudeResponse(claudeRaw);
        if (!aiData) {
          aiData = { reply: 'Samahani, kuna hitilafu kidogo. Tafadhali jaribu tena! 😊', is_vip: false };
        }

        var reply = String(aiData.reply || 'How can I help you?');
        // Safety check - never send raw JSON
        if (reply.trim().startsWith('{') || reply.includes('"intent"') || reply.includes('"direction"')) {
          reply = 'Karibu AfriDesk! How can I help you today? 😊';
        }

        var isVip = (calculation && calculation.isVip) || aiData.is_vip === true;

        // Save to history
        var updatedHistory = history.slice();
        updatedHistory.push({ role: 'user', content: currentMessage });
        updatedHistory.push({ role: 'assistant', content: reply });
        await saveHistory(customerId, updatedHistory);

        // Send VIP teller alert
        if (isVip) {
          var tellerNote = '🚨 VIP ENQUIRY\n👤 Customer: ' + senderName + '\n💱 Currency: ' + (calculation ? calculation.currency : aiData.currency || '?') + '\n💰 Amount: ' + (calculation ? calculation.amount.toLocaleString() : 'Large amount') + '\n📝 "' + currentMessage + '"\n✅ Contact customer for preferential rate NOW!';
          await sendChatwootMessage(conversationId, tellerNote, true);
          console.log('VIP alert sent!');
        }

        await sendChatwootMessage(conversationId, reply, false);
        console.log('Sent:', reply.substring(0, 80));

      } catch(err) {
        console.error('Error:', err.message);
      }
    });
  } else {
    res.writeHead(200);
    res.end('OK');
  }
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, async function() {
  console.log('AfriDesk API starting on port ' + PORT);
  await setupDB();
  console.log('AfriDesk Ready!');
});
