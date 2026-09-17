const https = require('https');
const http = require('http');
const { Client } = require('pg');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// Hardcoded fallback rates - always available
const FALLBACK_RATES = {
  USD: { buy: 129.0, sell: 130.0 },
  EUR: { buy: 148.0, sell: 151.0 },
  GBP: { buy: 173.5, sell: 177.0 },
  CAD: { buy: 91.0, sell: 95.0 },
  CHF: { buy: 156.0, sell: 163.0 },
  AUD: { buy: 90.0, sell: 95.0 },
  AED: { buy: 33.0, sell: 37.0 },
  CNY: { buy: 17.0, sell: 22.0 },
  ZAR: { buy: 7.0, sell: 10.0 },
  SAR: { buy: 31.0, sell: 35.0 },
  JPY: { buy: 0.7, sell: 1.0 },
  NOK: { buy: 9.0, sell: 15.0 },
  DKK: { buy: 14.0, sell: 20.0 },
  SEK: { buy: 9.0, sell: 12.0 },
  UGX: { buy: 0.03, sell: 0.05 },
  TZS: { buy: 0.04, sell: 0.06 },
  INR: { buy: 1.1, sell: 2.5 },
  QAR: { buy: 31.0, sell: 34.0 }
};

// Business information
const BUSINESS_INFO = {
  name: 'AfriDesk Forex Bureau',
  hours: 'Monday to Saturday: 8:00 AM - 5:00 PM | Sunday: 8:00 AM - 3:00 PM',
  branches: [
    'Branch 1: Standard Street, CBD Nairobi',
    'Branch 2: Wabera Street, CBD Nairobi'
  ],
  phone: '+254787510515'
};

// Google Sheet URL for rates sync
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || '';

// Fetch rates from Google Sheet
function fetchRatesFromSheet() {
  return new Promise(function(resolve) {
    if (!GOOGLE_SHEET_URL) return resolve({});
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
        console.log('Sheet rates fetched:', Object.keys(rates).join(','));
        resolve(rates);
      });
    }).on('error', function(err) {
      console.log('Sheet fetch error:', err.message);
      resolve({});
    });
  });
}

// Admin phone numbers allowed to update rates via WhatsApp
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '').split(',').filter(Boolean);

// Africa's Talking SMS
const AT_API_KEY = process.env.AT_API_KEY;
const AT_USERNAME = process.env.AT_USERNAME || 'sandbox';
const TELLER_PHONE = process.env.TELLER_PHONE;
const TELLER_WHATSAPP = process.env.TELLER_WHATSAPP || process.env.TELLER_PHONE;

function sendWhatsAppToTeller(phone, message) {
  return new Promise(function(resolve) {
    if (!CHATWOOT_TOKEN || !phone) return resolve(null);
    
    // Create or find contact and send message via Chatwoot API
    var searchBody = JSON.stringify({ q: phone });
    var searchOptions = {
      hostname: CHATWOOT_URL,
      path: '/api/v1/accounts/1/contacts/search?q=' + encodeURIComponent(phone) + '&include_contacts=true',
      method: 'GET',
      headers: {
        'api_access_token': CHATWOOT_TOKEN,
        'Content-Type': 'application/json'
      }
    };

    var req = https.request(searchOptions, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var result = JSON.parse(data);
          var contactId = result.payload && result.payload[0] && result.payload[0].id;
          if (contactId) {
            // Send new conversation to teller
            var convBody = JSON.stringify({
              inbox_id: 1,
              contact_id: contactId,
              additional_attributes: {},
              message: { content: message }
            });
            var convOptions = {
              hostname: CHATWOOT_URL,
              path: '/api/v1/accounts/1/conversations',
              method: 'POST',
              headers: {
                'api_access_token': CHATWOOT_TOKEN,
                'Content-Type': 'application/json',
                'content-length': Buffer.byteLength(convBody)
              }
            };
            var convReq = https.request(convOptions, function(r) {
              var d = '';
              r.on('data', function(c) { d += c; });
              r.on('end', function() {
                console.log('WhatsApp teller alert sent!');
                resolve(d);
              });
            });
            convReq.on('error', resolve);
            convReq.write(convBody);
            convReq.end();
          } else {
            console.log('Teller contact not found in Chatwoot');
            resolve(null);
          }
        } catch(e) {
          console.log('WhatsApp teller error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', resolve);
    req.end();
  });
}

function sendSMS(phone, message) {
  return new Promise(function(resolve) {
    if (!AT_API_KEY || !phone) {
      console.log('SMS not configured - skipping');
      return resolve(null);
    }

    var body = 'username=' + encodeURIComponent(AT_USERNAME) +
      '&to=' + encodeURIComponent(phone) +
      '&message=' + encodeURIComponent(message);

    var options = {
      hostname: process.env.AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com',
      path: '/version1/messaging',
      method: 'POST',
      headers: {
        'apiKey': AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        console.log('SMS sent! Response:', data.substring(0, 100));
        resolve(data);
      });
    });
    req.on('error', function(err) {
      console.log('SMS error:', err.message);
      resolve(null);
    });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.write(body);
    req.end();
  });
}

// Check if business is open (Nairobi time)
function isBusinessOpen() {
  // TESTING MODE - always open
  if (process.env.TESTING_MODE === 'true') return true;
  
  var now = new Date();
  var nairobi = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  var day = nairobi.getDay();
  var hour = nairobi.getHours();
  var minute = nairobi.getMinutes();
  var timeNum = hour * 100 + minute;

  if (day === 0) {
    return timeNum >= 800 && timeNum < 1500;
  } else if (day >= 1 && day <= 6) {
    return timeNum >= 800 && timeNum < 1700;
  }
  return false;
}

function getOpeningTime() {
  var now = new Date();
  var nairobi = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  var day = nairobi.getDay();
  var nextDay = new Date(nairobi);
  nextDay.setDate(nextDay.getDate() + 1);
  var nextDayName = nextDay.toLocaleDateString('en-KE', { weekday: 'long' });
  
  if (day === 6) { // Saturday - next is Sunday
    return 'tomorrow Sunday at 8:00 AM (closing 3:00 PM)';
  } else if (day === 0) { // Sunday - next is Monday
    return 'tomorrow Monday at 8:00 AM';
  } else {
    return nextDayName + ' at 8:00 AM';
  }
}

// Check for competitor mentions
function detectCompetitor(message) {
  var msg = message.toLowerCase();
  var competitors = ['equity', 'kcb', 'dtb', 'coop', 'stanbic', 'barclays', 'absa', 
    'ncba', 'i&m', 'family bank', 'postbank', 'western union', 'moneygram', 
    'world remit', 'sendwave', 'remitly', 'forex bureau', 'another bureau', 
    'other bureau', 'competitor', 'better rate', 'cheaper'];
  
  for (var i = 0; i < competitors.length; i++) {
    if (msg.includes(competitors[i])) {
      return competitors[i];
    }
  }
  return null;
}

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
    // Always update rates on startup
    for (var cur in FALLBACK_RATES) {
      await queryDB(
        'INSERT INTO rates (currency, buy_rate, sell_rate) VALUES ($1, $2, $3) ON CONFLICT (currency) DO UPDATE SET buy_rate=$2, sell_rate=$3, updated_at=NOW()',
        [cur, FALLBACK_RATES[cur].buy, FALLBACK_RATES[cur].sell]
      );
    }
    console.log('Rates updated on startup');
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
    'USD': ['usd', 'dollar', 'dollars', 'dola', 'doola', 'american', 'us dollar'],
    'EUR': ['eur', 'euro', 'euros'],
    'GBP': ['gbp', 'pound', 'pounds', 'sterling', 'uk money', 'british'],
    'AED': ['aed', 'dirham', 'dirhams', 'uae'],
    'CNY': ['cny', 'yuan', 'rmb', 'china money', 'chinese', 'pesa ya china', 'lacagta china'],
    'CAD': ['cad', 'canadian', 'canada dollar'],
    'AUD': ['aud', 'australian', 'australia dollar'],
    'INR': ['inr', 'rupee', 'rupees', 'indian'],
    'CHF': ['chf', 'swiss', 'switzerland', 'franc', 'francs'],
    'ZAR': ['zar', 'rand', 'south africa', 'south african'],
    'SAR': ['sar', 'riyal', 'riyals', 'saudi', 'saudi arabia'],
    'JPY': ['jpy', 'yen', 'japan', 'japanese'],
    'NOK': ['nok', 'norway', 'norwegian', 'krone', 'kroner'],
    'DKK': ['dkk', 'denmark', 'danish'],
    'SEK': ['sek', 'sweden', 'swedish', 'kronor'],
    'UGX': ['ugx', 'uganda', 'ugandan', 'shilling'],
    'TZS': ['tzs', 'tanzania', 'tanzanian'],
    'QAR': ['qar', 'qatar', 'qatari']
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

        // HUMAN HANDOFF: If conversation is assigned to a human agent - bot stays silent
        var conversationStatus = payload.conversation && payload.conversation.status;
        var assigneeId = payload.conversation && payload.conversation.meta && payload.conversation.meta.assignee;
        if (assigneeId) {
          console.log('Conversation assigned to human agent - bot staying silent');
          return;
        }

        // AFTER HOURS: Check if business is open
        if (!isBusinessOpen()) {
          var openTime = getOpeningTime();
          var closedReply = senderName + ', asante sana kwa kuwasiliana na sisi! 😊 Kwa sasa tumefunga, lakini tutafurahi kukusaidia ' + openTime + '. Tuna matawi mawili - Standard Street CBD na Wabera Street CBD. Acha jina lako na inquiry yako na tutakupigia simu asubuhi! 💪🌙';
          await sendChatwootMessage(conversationId, closedReply, false);
          // Log after-hours inquiry as private note
          var afterHoursNote = '🕐 AFTER HOURS INQUIRY\n👤 ' + senderName + '\n📝 "' + currentMessage + '"\n⏰ ' + new Date().toLocaleString("en-KE", {timeZone: "Africa/Nairobi"}) + '\n✅ Follow up when business opens!';
          await sendChatwootMessage(conversationId, afterHoursNote, true);
          console.log('After hours inquiry from:', senderName);
          return;
        }

        // COMPETITOR INTELLIGENCE: Log competitor mentions
        var competitor = detectCompetitor(currentMessage);
        if (competitor) {
          var competitorNote = '🔍 COMPETITOR MENTION\n👤 ' + senderName + '\n🏦 Mentioned: ' + competitor + '\n📝 "' + currentMessage + '"\n⚡ Customer may be shopping around - follow up!';
          await sendChatwootMessage(conversationId, competitorNote, true);
          console.log('Competitor mentioned:', competitor);
        }

        // ADMIN COMMAND: Check if message is from admin and is a rate update command
        var senderPhone = String((payload.sender && payload.sender.phone_number) || '').replace(/\s/g, '');
        var isAdmin = ADMIN_PHONES.length === 0 || ADMIN_PHONES.some(function(p) { return senderPhone.includes(p.trim()); });
        
        if (isAdmin && currentMessage.toUpperCase().startsWith('RATES ')) {
          // Format: RATES USD 131 132 or RATES USD BUY 131 SELL 132
          var parts = currentMessage.toUpperCase().split(' ');
          if (parts.length >= 4) {
            var updateCur = parts[1];
            var buyRate = parseFloat(parts[2]);
            var sellRate = parseFloat(parts[3]);
            if (updateCur && buyRate > 0 && sellRate > 0) {
              try {
                await queryDB(
                  'INSERT INTO rates (currency, buy_rate, sell_rate, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (currency) DO UPDATE SET buy_rate=$2, sell_rate=$3, updated_at=NOW()',
                  [updateCur, buyRate, sellRate]
                );
                await sendChatwootMessage(conversationId, '✅ Rates updated! ' + updateCur + ' Buy: ' + buyRate + ' Sell: ' + sellRate, false);
                console.log('Admin updated rates:', updateCur, buyRate, sellRate);
              } catch(e) {
                await sendChatwootMessage(conversationId, '❌ Rate update failed: ' + e.message, false);
              }
              return;
            }
          }
          await sendChatwootMessage(conversationId, '❌ Format: RATES USD 131 132', false);
          return;
        }
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

        var system = 'You are Hassan, a warm witty and persuasive forex assistant at AfriDesk Forex Bureau, Nairobi Kenya. BUSINESS INFO: Hours: Monday-Saturday 8AM-5PM, Sunday 8AM-3PM. Branches: Standard Street CBD and Wabera Street CBD. Phone: +254787510515.\n\nCORE RULES:\n1. Always respond with ONLY valid JSON - nothing else\n2. Use customer name naturally\n3. Reply in same language as customer (English/Swahili/Sheng/Somali)\n4. Use conversation history - never ask for info already given\n5. NEVER calculate rates yourself - use CALCULATION RESULT if provided\n6. Share CALCULATION RESULT numbers naturally\n\nRATE DIRECTION RULES:\n7. Customer SELLING foreign currency (has USD/EUR/CNY wants KES) = they get BUY rate\n8. Customer BUYING foreign currency (wants USD/EUR/CNY pays KES) = they pay SELL rate\n9. NEVER agree to a rate the customer requests. If customer asks can I get 130 for USD reply: Our current buy rate is 128.5 - our senior dealer will confirm the best possible rate for your amount\n10. Never promise to match competitor rates - always escalate to dealer\n\nSALES RULES:\n11. When customer mentions competitor rate - acknowledge then create urgency and escalate\n12. Create urgency naturally - rates change every hour\n13. Offer to connect customer with senior dealer for better rate\n14. Be trusted advisor not pushy salesman\n\nBARGAINING RULES:\n15. If customer insists on better rate or bargains - set is_bargain to true\n16. Tell customer senior dealer will contact them personally\n17. Always make customer feel valued and important\n\nVIP RULES:\n18. VIP: true means senior teller will contact for preferential rate\n19. Large amounts always deserve personal attention\n\nCLOSING RULES:\n20. After providing calculation or completing an exchange inquiry always end with a warm closing: mention our branches (Standard Street CBD or Wabera Street CBD) naturally\n21. After transaction calculation say: Our senior dealer will contact you shortly to confirm and finalize your transaction\n22. Always make customer feel valued - they are not just a transaction\n\nJSON FORMAT:\n{"intent":"greeting|rates|exchange|smalltalk|bargain|other","direction":"buy|sell|null","currency":"USD|EUR|GBP|AED|CNY|CAD|AUD|INR|null","amount":null,"is_vip":false,"is_bargain":false,"reply":"your natural response"}';


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
        var isBargain = aiData.is_bargain === true;

        // Save to history
        var updatedHistory = history.slice();
        updatedHistory.push({ role: 'user', content: currentMessage });
        updatedHistory.push({ role: 'assistant', content: reply });
        await saveHistory(customerId, updatedHistory);

        // Send VIP teller alert
        if (isVip) {
          var tellerNote = '🚨 VIP ENQUIRY\n👤 Customer: ' + senderName + '\n💱 Currency: ' + (calculation ? calculation.currency : aiData.currency || '?') + '\n💰 Amount: ' + (calculation ? calculation.amount.toLocaleString() : 'Large amount') + '\n📝 "' + currentMessage + '"\n✅ Contact customer for preferential rate NOW!';
          await sendChatwootMessage(conversationId, tellerNote, true);
          // SMS alert to teller
          var vipSMS = 'VIP ALERT! Customer: ' + senderName + ' wants to ' + (calculation ? calculation.direction + ' ' + calculation.amount.toLocaleString() + ' ' + calculation.currency : 'large transaction') + '. Contact NOW for preferential rate! - AfriDesk';
          await sendSMS(TELLER_PHONE, vipSMS);
          await sendWhatsAppToTeller(TELLER_WHATSAPP, tellerNote);
          console.log('VIP alert sent!');
        }

        // Send BARGAIN alert when customer negotiates
        if (isBargain && !isVip) {
          var bargainNote = '💬 BARGAIN REQUEST\n👤 Customer: ' + senderName + '\n💱 Currency: ' + (calculation ? calculation.currency : aiData.currency || '?') + '\n💰 Amount: ' + (calculation ? calculation.amount.toLocaleString() : 'Unknown') + '\n📝 "' + currentMessage + '"\n⚡ Customer is negotiating — senior dealer should contact ASAP!';
          await sendChatwootMessage(conversationId, bargainNote, true);
          // SMS alert to teller for bargain
          var bargainSMS = 'BARGAIN ALERT! Customer: ' + senderName + ' is negotiating rates. Contact ASAP! - AfriDesk';
          await sendSMS(TELLER_PHONE, bargainSMS);
          await sendWhatsAppToTeller(TELLER_WHATSAPP, bargainNote);
          console.log('Bargain alert sent!');
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

  // Sync rates from Google Sheet every 5 minutes
  if (GOOGLE_SHEET_URL) {
    setInterval(async function() {
      try {
        var sheetRates = await fetchRatesFromSheet();
        if (Object.keys(sheetRates).length > 0) {
          for (var cur in sheetRates) {
            await queryDB(
              'INSERT INTO rates (currency, buy_rate, sell_rate, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (currency) DO UPDATE SET buy_rate=$2, sell_rate=$3, updated_at=NOW()',
              [cur, sheetRates[cur].buy, sheetRates[cur].sell]
            );
          }
          console.log('Rates synced from Google Sheet at', new Date().toLocaleString('en-KE', {timeZone: 'Africa/Nairobi'}));
        }
      } catch(e) {
        console.log('Rate sync error:', e.message);
      }
    }, 5 * 60 * 1000);
    console.log('Rate sync scheduled every 5 minutes!');
  }
});
