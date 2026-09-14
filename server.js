const https = require('https');
const http = require('http');
const { Client } = require('pg');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQbnna-vcEFstuBQvVLP1bFLEveKMrJ1DAeWzVjHKi_WAJnDvJzg4KTlWWYNOcc8hffAayMBLYgYLoR/pub?output=csv';

// Database setup
async function getDB() {
  var client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function setupDB() {
  var db = await getDB();
  await db.query(`
    CREATE TABLE IF NOT EXISTS rates (
      currency VARCHAR(10) PRIMARY KEY,
      buy_rate DECIMAL(10,4),
      sell_rate DECIMAL(10,4),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      customer_id VARCHAR(100) PRIMARY KEY,
      messages JSONB DEFAULT '[]',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await db.end();
  console.log('Database ready!');
}

async function getRatesFromDB() {
  var db = await getDB();
  var result = await db.query('SELECT currency, buy_rate, sell_rate FROM rates');
  await db.end();
  var rates = {};
  result.rows.forEach(function(row) {
    rates[row.currency] = { buy: parseFloat(row.buy_rate), sell: parseFloat(row.sell_rate) };
  });
  return rates;
}

async function updateRatesInDB(rates) {
  var db = await getDB();
  for (var cur in rates) {
    await db.query(
      'INSERT INTO rates (currency, buy_rate, sell_rate, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (currency) DO UPDATE SET buy_rate=$2, sell_rate=$3, updated_at=NOW()',
      [cur, rates[cur].buy, rates[cur].sell]
    );
  }
  await db.end();
}

async function getHistory(customerId) {
  var db = await getDB();
  var result = await db.query('SELECT messages FROM conversations WHERE customer_id=$1', [customerId]);
  await db.end();
  return result.rows.length > 0 ? result.rows[0].messages : [];
}

async function saveHistory(customerId, messages) {
  var db = await getDB();
  var recent = messages.slice(-20);
  await db.query(
    'INSERT INTO conversations (customer_id, messages, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (customer_id) DO UPDATE SET messages=$2, updated_at=NOW()',
    [customerId, JSON.stringify(recent)]
  );
  await db.end();
}

function fetchRatesFromSheet() {
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
            var buy = parseFloat(cols[3]) || 0;
            var sell = parseFloat(cols[4]) || 0;
            if (buy > 0) rates[cur] = { buy: buy, sell: sell };
          }
        }
        console.log('Sheet rates:', Object.keys(rates).join(','));
        resolve(rates);
      });
    }).on('error', function(err) {
      console.log('Sheet error:', err.message);
      resolve({});
    });
  });
}

async function getRates() {
  // Try Google Sheet first, save to DB, fallback to DB
  var sheetRates = await fetchRatesFromSheet();
  if (Object.keys(sheetRates).length > 0) {
    await updateRatesInDB(sheetRates);
    return sheetRates;
  }
  console.log('Falling back to DB rates');
  return await getRatesFromDB();
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

function detectIntent(message, rates) {
  var msg = message.toLowerCase();
  var result = { currency: null, amount: null, direction: null };

  // Currency detection
  var currencyMap = {
    'USD': ['usd','dollar','dollars','dola','$'],
    'EUR': ['eur','euro','euros'],
    'GBP': ['gbp','pound','pounds','sterling'],
    'AED': ['aed','dirham','dirhams'],
    'CNY': ['cny','yuan','rmb','china money','chinese','pesa ya china'],
    'CAD': ['cad','canadian'],
    'AUD': ['aud','australian'],
    'INR': ['inr','rupee','rupees']
  };

  for (var cur in currencyMap) {
    if (currencyMap[cur].some(function(k) { return msg.includes(k); })) {
      result.currency = cur;
      break;
    }
  }

  // Amount detection
  var amountMatch = msg.match(/(\d[\d,]*(?:\.\d+)?)\s*k\b/);
  if (amountMatch) {
    result.amount = parseFloat(amountMatch[1].replace(',','')) * 1000;
  } else {
    amountMatch = msg.replace(/,/g,'').match(/\b(\d+(?:\.\d+)?)\b/);
    if (amountMatch) result.amount = parseFloat(amountMatch[1]);
  }

  // Direction
  if (msg.match(/\b(sell|kuuza|nauza|i have|nina|lacagta hayaa)\b/)) result.direction = 'sell';
  else if (msg.match(/\b(buy|kununua|nunua|i want|nataka|i need)\b/)) result.direction = 'buy';

  return result;
}

var server = http.createServer(function(req, res) {
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
        console.log('From', senderName + ':', currentMessage);

        // Get rates and history in parallel
        var results = await Promise.all([getRates(), getHistory(customerId)]);
        var rates = results[0];
        var history = results[1];

        // Node.js handles calculation
        var intent = detectIntent(currentMessage, rates);
        var calculation = null;

        if (intent.currency && intent.amount && rates[intent.currency]) {
          var rate = rates[intent.currency];
          var dir = intent.direction || 'sell';
          var kesAmount = dir === 'sell' ? intent.amount * rate.buy : intent.amount * rate.sell;
          calculation = {
            currency: intent.currency,
            amount: intent.amount,
            direction: dir,
            rate: dir === 'sell' ? rate.buy : rate.sell,
            kes: kesAmount,
            isVip: intent.amount >= 5000 && intent.currency === 'USD'
          };
        }

        // Build rate summary for Claude
        var ratesSummary = Object.entries(rates).map(function(e) {
          return e[0] + '(buy:' + e[1].buy + ' sell:' + e[1].sell + ')';
        }).join(' ');

        // Build messages for Claude
        var messages = history.slice();
        var userContent = '[Customer:' + senderName + '] [Date:' + new Date().toDateString() + '] [Rates:' + ratesSummary + ']';
        if (calculation) {
          userContent += ' [CALCULATION DONE: Customer wants to ' + calculation.direction + ' ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + ' at rate ' + calculation.rate + ' = KSh ' + calculation.kes.toLocaleString() + ']';
        }
        userContent += ' ' + currentMessage;
        messages.push({ role: 'user', content: userContent });

        var system = 'You are Hassan, a warm witty forex assistant at AfriDesk East Africa.\n\nRULES:\n1. Use customer name naturally and build rapport\n2. Reply in customer language (English/Swahili/Sheng/Somali)\n3. NEVER calculate or estimate rates - calculations are done for you in [CALCULATION DONE:...]\n4. When [CALCULATION DONE] is provided, use those exact numbers in your reply\n5. For VIP (above 5000 USD), say teller will contact with preferential rate\n6. Never repeat questions already answered in conversation history\n7. Be concise, warm, and natural - not robotic\n\nReturn ONLY valid JSON:\n{"intent":"","direction":"buy|sell|null","currency":"ISO or null","amount":null,"is_vip":false,"reply":"your natural response"}';

        var claudeText = await callClaude(messages, system);
        var clean = claudeText.replace(/```json|```/g, '').trim();

        var aiData = {};
        try {
          aiData = JSON.parse(clean);
        } catch(e) {
          aiData = { reply: clean.length > 10 && clean.length < 800 ? clean : "How can I help you today?", is_vip: false };
        }

        var reply = aiData.reply || "How can I help you?";
        var isVip = (calculation && calculation.isVip) || aiData.is_vip || false;

        // Save history to PostgreSQL
        history.push({ role: 'user', content: currentMessage });
        history.push({ role: 'assistant', content: reply });
        await saveHistory(customerId, history);

        // VIP teller alert
        if (isVip) {
          var tellerNote = '🚨 VIP ENQUIRY\n👤 ' + senderName + '\n💱 ' + (calculation ? calculation.currency : aiData.currency || '?') + '\n💰 ' + (calculation ? calculation.amount.toLocaleString() : '?') + '\n📝 "' + currentMessage + '"\n✅ Contact customer for preferential rate.';
          await sendChatwootMessage(conversationId, tellerNote, true);
        }

        await sendChatwootMessage(conversationId, reply, false);
        console.log('Sent:', reply.substring(0, 60));

      } catch(err) {
        console.error('Error:', err.message);
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('AfriDesk API Running with PostgreSQL!');
  } else {
    res.writeHead(200);
    res.end('OK');
  }
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, async function() {
  console.log('AfriDesk API starting on port ' + PORT);
  await setupDB();
  console.log('Ready!');
});
