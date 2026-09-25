const https = require('https');
const http = require('http');
const { Client } = require('pg');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const AT_API_KEY = process.env.AT_API_KEY;
const AT_USERNAME = process.env.AT_USERNAME || 'sandbox';
const TELLER_PHONE = process.env.TELLER_PHONE;
const TELLER_WHATSAPP = process.env.TELLER_WHATSAPP || process.env.TELLER_PHONE;
const TELLER_AGENT_ID = process.env.TELLER_AGENT_ID || '2';
const VIP_THRESHOLD_KES = parseInt(process.env.VIP_THRESHOLD_KES || '650000');
const MOBILESASA_TOKEN = process.env.MOBILESASA_TOKEN;
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || '';
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '').split(',').filter(Boolean);

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

const BUSINESS_INFO = {
  name: 'AfriDesk Forex Bureau',
  hours: 'Monday to Saturday 8AM-5PM Sunday 8AM-3PM',
  branches: 'Standard Street CBD and Wabera Street CBD',
  phone: '+254787510515'
};

function isBusinessOpen() {
  if (process.env.TESTING_MODE === 'true') return true;
  var now = new Date();
  var nairobi = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  var day = nairobi.getDay();
  var hour = nairobi.getHours();
  var minute = nairobi.getMinutes();
  var timeNum = hour * 100 + minute;
  if (day === 0) return timeNum >= 800 && timeNum < 1500;
  if (day >= 1 && day <= 6) return timeNum >= 800 && timeNum < 1700;
  return false;
}

function getOpeningTime() {
  var now = new Date();
  var nairobi = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  var day = nairobi.getDay();
  var nextDay = new Date(nairobi);
  nextDay.setDate(nextDay.getDate() + 1);
  var nextDayName = nextDay.toLocaleDateString('en-KE', { weekday: 'long' });
  if (day === 6) return 'tomorrow Sunday at 8AM (closing 3PM)';
  if (day === 0) return 'tomorrow Monday at 8AM';
  return nextDayName + ' at 8AM';
}

function detectCompetitor(message) {
  var msg = message.toLowerCase();
  var competitors = ['equity', 'kcb', 'dtb', 'coop', 'stanbic', 'barclays', 'absa', 'ncba', 'family bank',
    'western union', 'moneygram', 'world remit', 'sendwave', 'remitly', 'forex bureau',
    'another bureau', 'other bureau', 'better rate', 'continental', 'kenex'];
  for (var i = 0; i < competitors.length; i++) {
    if (msg.includes(competitors[i])) return competitors[i];
  }
  return null;
}

async function queryDB(sql, params) {
  var client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
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
    await queryDB('CREATE TABLE IF NOT EXISTS rates (currency VARCHAR(10) PRIMARY KEY, buy_rate DECIMAL(10,4), sell_rate DECIMAL(10,4), updated_at TIMESTAMP DEFAULT NOW())');
    await queryDB('CREATE TABLE IF NOT EXISTS conversations (customer_id VARCHAR(100) PRIMARY KEY, conversation_id VARCHAR(100), messages JSONB DEFAULT \'[]\', updated_at TIMESTAMP DEFAULT NOW())');
    await queryDB('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(100)').catch(function(){});
    for (var cur in FALLBACK_RATES) {
      await queryDB('INSERT INTO rates (currency, buy_rate, sell_rate) VALUES ($1, $2, $3) ON CONFLICT (currency) DO UPDATE SET buy_rate=$2, sell_rate=$3, updated_at=NOW()', [cur, FALLBACK_RATES[cur].buy, FALLBACK_RATES[cur].sell]);
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
      result.rows.forEach(function(row) { rates[row.currency] = { buy: parseFloat(row.buy_rate), sell: parseFloat(row.sell_rate) }; });
      return rates;
    }
  } catch(e) { console.log('DB rates error:', e.message); }
  return FALLBACK_RATES;
}

async function getHistory(customerId) {
  try {
    var result = await queryDB('SELECT messages FROM conversations WHERE customer_id=$1', [customerId]);
    if (result.rows.length > 0) return result.rows[0].messages || [];
  } catch(e) { console.log('History get error:', e.message); }
  return [];
}

async function saveHistory(customerId, messages, conversationId) {
  try {
    var recent = messages.slice(-20);
    await queryDB('INSERT INTO conversations (customer_id, conversation_id, messages, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (customer_id) DO UPDATE SET conversation_id=$2, messages=$3, updated_at=NOW()', [customerId, conversationId, JSON.stringify(recent)]);
  } catch(e) { console.log('History save error:', e.message); }
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
    'SAR': ['sar', 'riyal', 'riyals', 'saudi'],
    'JPY': ['jpy', 'yen', 'japan', 'japanese'],
    'NOK': ['nok', 'norway', 'norwegian', 'kroner'],
    'DKK': ['dkk', 'denmark', 'danish'],
    'SEK': ['sek', 'sweden', 'swedish', 'kronor'],
    'UGX': ['ugx', 'uganda', 'ugandan'],
    'TZS': ['tzs', 'tanzania', 'tanzanian'],
    'QAR': ['qar', 'qatar', 'qatari']
  };
  for (var cur in currencyMap) {
    for (var i = 0; i < currencyMap[cur].length; i++) {
      if (msg.includes(currencyMap[cur][i])) { result.currency = cur; break; }
    }
    if (result.currency) break;
  }
  var kMatch = msg.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (kMatch) { result.amount = parseFloat(kMatch[1]) * 1000; }
  else {
    var numMatch = msg.replace(/,/g, '').match(/\b(\d{2,}(?:\.\d+)?)\b/);
    if (numMatch) result.amount = parseFloat(numMatch[1]);
  }
  if (msg.match(/\b(sell|selling|kuuza|nauza|i have|nina|have cny|have usd|have gbp|have eur|have chf)\b/)) result.direction = 'sell';
  else if (msg.match(/\b(buy|buying|kununua|nunua|nataka|i want|i need|need)\b/)) result.direction = 'buy';
  return result;
}

function parseClaudeResponse(text) {
  if (!text) return null;
  var clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(clean); } catch(e) {}
  var match = clean.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch(e) {} }
  if (clean.length > 5 && clean.length < 2000 && !clean.startsWith('{')) {
    return { reply: clean, is_vip: false, is_bargain: false, intent: 'unknown' };
  }
  return null;
}

function callClaude(messages, system) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: system, messages: messages });
    var options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { var result = JSON.parse(data); resolve(result.content && result.content[0] ? result.content[0].text : ''); }
        catch(e) { resolve(''); }
      });
    });
    req.on('error', function() { resolve(''); });
    setTimeout(function() { req.destroy(); resolve(''); }, 15000);
    req.write(body);
    req.end();
  });
}

function sendChatwootMessage(conversationId, content, isPrivate) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ content: content, message_type: 'outgoing', private: isPrivate || false });
    var options = {
      hostname: CHATWOOT_URL, path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages', method: 'POST',
      headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) { res.on('data', function(){}); res.on('end', resolve); });
    req.on('error', resolve);
    setTimeout(function() { req.destroy(); resolve(); }, 10000);
    req.write(body);
    req.end();
  });
}

function assignConversationToTeller(conversationId) {
  return new Promise(function(resolve) {
    if (!CHATWOOT_TOKEN || !conversationId) return resolve(null);
    var body = JSON.stringify({ assignee_id: parseInt(TELLER_AGENT_ID) });
    var options = {
      hostname: CHATWOOT_URL, path: '/api/v1/accounts/1/conversations/' + conversationId + '/assignments', method: 'POST',
      headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { console.log('Conversation assigned to teller! ID:', conversationId); resolve(true); });
    });
    req.on('error', function(e) { console.log('Assignment error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

function sendSMS(phone, message) {
  return new Promise(function(resolve) {
    if (!phone) return resolve(null);
    if (MOBILESASA_TOKEN) {
      var body = JSON.stringify({ senderID: 'MOBILESASA', phone: phone, message: message });
      var options = {
        hostname: 'api.mobilesasa.com', path: '/v1/send/message', method: 'POST',
        headers: { 'Authorization': 'Bearer ' + MOBILESASA_TOKEN, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      var req = https.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() { console.log('Mobile Sasa SMS sent! Response:', data.substring(0, 100)); resolve(data); });
      });
      req.on('error', function(err) { console.log('SMS error:', err.message); resolve(null); });
      setTimeout(function() { req.destroy(); resolve(null); }, 10000);
      req.write(body);
      req.end();
    } else {
      console.log('No SMS provider configured');
      resolve(null);
    }
  });
}

function makeVoiceCall(phone, message) {
  return new Promise(function(resolve) {
    if (!AT_API_KEY || !phone || !process.env.AT_CALLER_ID) { console.log('Voice call not configured'); return resolve(null); }
    var callBody = 'username=' + encodeURIComponent(AT_USERNAME) + '&to=' + encodeURIComponent(phone) + '&from=' + encodeURIComponent(process.env.AT_CALLER_ID);
    var hostname = AT_USERNAME === 'sandbox' ? 'voice.sandbox.africastalking.com' : 'voice.africastalking.com';
    var options = {
      hostname: hostname, path: '/call', method: 'POST',
      headers: { 'apiKey': AT_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(callBody) }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { console.log('Voice call initiated! Response:', data.substring(0, 100)); resolve(data); });
    });
    req.on('error', function(err) { console.log('Voice call error:', err.message); resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.write(callBody);
    req.end();
  });
}

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
        resolve(rates);
      });
    }).on('error', function() { resolve({}); });
  });
}

async function getActiveCustomers() {
  try {
    var result = await queryDB("SELECT customer_id, conversation_id FROM conversations WHERE updated_at > NOW() - INTERVAL '24 hours' AND conversation_id IS NOT NULL");
    console.log('Active customers found:', result.rows.length);
    return result.rows || [];
  } catch(e) { console.log('Get active customers error:', e.message); return []; }
}

async function sendMorningBroadcast() {
  try {
    var nairobi = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    console.log('Morning broadcast starting:', nairobi);
    var rates = await getRates();
    var today = new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Nairobi' });
    var rateMsg = 'Habari za asubuhi! Good morning!\nKaribu AfriDesk Forex Bureau.\n' + today + '\n\nHizi ndizo rates za leo:\n\n';
    if (rates.USD) rateMsg += 'USD (Dollar)\nBuy: ' + rates.USD.buy + ' | Sell: ' + rates.USD.sell + '\n\n';
    if (rates.EUR) rateMsg += 'EUR (Euro)\nBuy: ' + rates.EUR.buy + ' | Sell: ' + rates.EUR.sell + '\n\n';
    if (rates.GBP) rateMsg += 'GBP (Pound)\nBuy: ' + rates.GBP.buy + ' | Sell: ' + rates.GBP.sell + '\n\n';
    if (rates.AED) rateMsg += 'AED (Dirham)\nBuy: ' + rates.AED.buy + ' | Sell: ' + rates.AED.sell + '\n\n';
    if (rates.CNY) rateMsg += 'CNY (Yuan)\nBuy: ' + rates.CNY.buy + ' | Sell: ' + rates.CNY.sell + '\n\n';
    if (rates.CHF) rateMsg += 'CHF (Swiss Franc)\nBuy: ' + rates.CHF.buy + ' | Sell: ' + rates.CHF.sell + '\n\n';
    if (rates.SAR) rateMsg += 'SAR (Saudi Riyal)\nBuy: ' + rates.SAR.buy + ' | Sell: ' + rates.SAR.sell + '\n\n';
    if (rates.INR) rateMsg += 'INR (Rupee)\nBuy: ' + rates.INR.buy + ' | Sell: ' + rates.INR.sell + '\n\n';
    rateMsg += 'Tuna matawi mawili:\nStandard Street CBD na Wabera Street CBD\n\n';
    rateMsg += 'Tunafungua: Mon-Sat 8AM-5PM | Sun 8AM-3PM\n';
    rateMsg += 'Simu: +254787510515\n\nKaribu sana! Have a productive day!';
    var customers = await getActiveCustomers();
    var sent = 0;
    for (var i = 0; i < customers.length; i++) {
      var convId = customers[i].conversation_id;
      if (!convId) continue;
      try {
        await sendChatwootMessage(convId, rateMsg, false);
        sent++;
        await new Promise(function(r) { setTimeout(r, 1000); });
      } catch(e) { console.log('Broadcast error:', e.message); }
    }
    console.log('Morning broadcast complete! Sent to:', sent, 'customers');
  } catch(e) { console.log('Morning broadcast failed:', e.message); }
}

var server = http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('AfriDesk API Running!'); return;
  }
  if (req.method === 'GET' && req.url === '/broadcast-now') {
    res.writeHead(200); res.end('Broadcast triggered!');
    sendMorningBroadcast(); return;
  }
  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      res.writeHead(200); res.end('OK');
      try {
        var payload = JSON.parse(body);
        if (payload.event !== 'message_created' || payload.message_type !== 'incoming') return;
        var currentMessage = String(payload.content || '').trim();
        var conversationId = payload.conversation && payload.conversation.id;
        var senderName = String((payload.sender && payload.sender.name) || 'friend').replace(/["\\\n\r\t]/g, ' ').trim();
        var customerId = String((payload.sender && payload.sender.id) || conversationId);
        var customerPhone = String((payload.sender && payload.sender.phone_number) || '');
        if (!currentMessage || !conversationId) return;
        console.log('MSG from', senderName + ':', currentMessage);

        // Human handoff check
        var assigneeId = payload.conversation && payload.conversation.meta && payload.conversation.meta.assignee;
        if (assigneeId) { console.log('Conversation assigned to human agent - bot silent'); return; }

        // After hours check
        if (!isBusinessOpen()) {
          var openTime = getOpeningTime();
          var closedReply = senderName + ', asante sana kwa kuwasiliana na sisi! Kwa sasa tumefunga, lakini tutafurahi kukusaidia ' + openTime + '. Tuna matawi mawili - Standard Street CBD na Wabera Street CBD. Acha jina lako na inquiry yako na tutakupigia simu asubuhi!';
          await sendChatwootMessage(conversationId, closedReply, false);
          await sendChatwootMessage(conversationId, 'AFTER HOURS INQUIRY\nCustomer: ' + senderName + '\n"' + currentMessage + '"', true);
          return;
        }

        // Admin rate update
        var senderPhone = String((payload.sender && payload.sender.phone_number) || '').replace(/\s/g, '');

        // BROADCAST command - smart WhatsApp + SMS fallback
        if (currentMessage.toUpperCase().startsWith('BROADCAST ')) {
          var broadcastMsg = currentMessage.substring(10).trim();
          if (broadcastMsg.length > 0) {
            await sendChatwootMessage(conversationId, 'Broadcasting your message now — WhatsApp for active customers, SMS fallback for others...', false);
            // Get ALL customers with their details
            var allCustomers = await queryDB("SELECT customer_id, conversation_id, messages, updated_at FROM conversations WHERE conversation_id IS NOT NULL");
            var waSent = 0;
            var smsSent = 0;
            var now = new Date();
            for (var bi = 0; bi < allCustomers.rows.length; bi++) {
              var cust = allCustomers.rows[bi];
              if (cust.conversation_id === String(conversationId)) continue;
              // Check if within 24 hour window
              var lastActive = new Date(cust.updated_at);
              var hoursAgo = (now - lastActive) / (1000 * 60 * 60);
              if (hoursAgo <= 24) {
                // WhatsApp is open — send via Chatwoot
                try {
                  await sendChatwootMessage(cust.conversation_id, broadcastMsg, false);
                  waSent++;
                  await new Promise(function(r) { setTimeout(r, 500); });
                } catch(e) { console.log('WA broadcast error:', e.message); }
              } else {
                // WhatsApp window closed — fallback to SMS
                // Extract phone from messages history
                var msgs = cust.messages || [];
                var custPhone = null;
                // Try to get phone from customer_id (often contains phone)
                if (cust.customer_id && cust.customer_id.match(/\d{10,}/)) {
                  custPhone = cust.customer_id.replace(/\D/g, '');
                }
                if (custPhone) {
                  try {
                    await sendSMS(custPhone, broadcastMsg + ' -AfriDesk +254787510515');
                    smsSent++;
                    await new Promise(function(r) { setTimeout(r, 500); });
                  } catch(e) { console.log('SMS fallback error:', e.message); }
                }
              }
            }
            var summary = 'Broadcast complete! WhatsApp: ' + waSent + ' customers. SMS fallback: ' + smsSent + ' customers. Total reached: ' + (waSent + smsSent);
            await sendChatwootMessage(conversationId, summary, false);
            console.log('Smart broadcast complete! WA:', waSent, 'SMS:', smsSent);
            return;
          }
        }

        if (currentMessage.toUpperCase().startsWith('RATES ')) {
          var parts = currentMessage.toUpperCase().split(' ');
          if (parts.length >= 4) {
            var updateCur = parts[1];
            var buyRate = parseFloat(parts[2]);
            var sellRate = parseFloat(parts[3]);
            if (updateCur && buyRate > 0 && sellRate > 0) {
              try {
                await queryDB('INSERT INTO rates (currency, buy_rate, sell_rate, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (currency) DO UPDATE SET buy_rate=$2, sell_rate=$3, updated_at=NOW()', [updateCur, buyRate, sellRate]);
                await sendChatwootMessage(conversationId, 'Rates updated! ' + updateCur + ' Buy: ' + buyRate + ' Sell: ' + sellRate, false);
              } catch(e) { await sendChatwootMessage(conversationId, 'Rate update failed: ' + e.message, false); }
              return;
            }
          }
        }

        // Competitor detection
        var competitor = detectCompetitor(currentMessage);
        if (competitor) {
          await sendChatwootMessage(conversationId, 'COMPETITOR MENTION\nCustomer: ' + senderName + '\nMentioned: ' + competitor + '\n"' + currentMessage + '"', true);
          console.log('Competitor mentioned:', competitor);
        }

        // Load rates and history
        var loaded = await Promise.all([getRates(), getHistory(customerId)]);
        var rates = loaded[0];
        var history = loaded[1];

        // Intent detection
        var intent = detectIntent(currentMessage);
        var calculation = null;

        if (!intent.currency && history.length > 0) {
          var recentHistory = history.slice(-4);
          for (var h = recentHistory.length - 1; h >= 0; h--) {
            if (recentHistory[h].role === 'user') {
              var histIntent = detectIntent(recentHistory[h].content);
              if (histIntent.currency) { intent.currency = histIntent.currency; if (!intent.direction) intent.direction = histIntent.direction; break; }
            }
          }
        }

        if (intent.currency && intent.amount && rates[intent.currency]) {
          var rate = rates[intent.currency];
          var dir = intent.direction || 'sell';
          var kesAmount = dir === 'sell' ? Math.round(intent.amount * rate.buy) : Math.round(intent.amount * rate.sell);
          calculation = { currency: intent.currency, amount: intent.amount, direction: dir, rate: dir === 'sell' ? rate.buy : rate.sell, kes: kesAmount, isVip: (intent.amount * rate.buy) >= VIP_THRESHOLD_KES };
          console.log('Calc:', dir, intent.amount, intent.currency, '=', kesAmount, 'KES');
        }

        // Keyword detection
        var msgLower = currentMessage.toLowerCase();
        var bargainKeywords = ['better rate', 'cheaper', 'negotiate', 'discount', 'can you do', 'beat that', 'match the rate', 'other bureau', 'competitor', 'offered me', 'lower rate', 'too low', 'elsewhere', 'down a bit', 'punguza', 'bei nzuri', 'wanipe'];
        var complaintKeywords = ['complaint', 'complain', 'unhappy', 'terrible', 'fraud', 'cheat', 'cheated', 'scam', 'wrong rate', 'wrong amount', 'refund', 'police', 'lawyer', 'malalamiko', 'nimedanganywa', 'nimeibiwa', 'rudisha'];
        var acceptanceKeywords = ['i accept', 'i agree', 'deal', 'ok i will come', 'i will come', 'on my way', 'coming now', 'nataka kuja', 'nakuja', 'sawa nimekubali', 'lets do it', 'yes i confirm', 'confirmed', 'book it', 'proceed', 'go ahead'];
        var nodeDetectedBargain = bargainKeywords.some(function(kw) { return msgLower.includes(kw); });
        var nodeDetectedComplaint = complaintKeywords.some(function(kw) { return msgLower.includes(kw); });
        var nodeDetectedAcceptance = acceptanceKeywords.some(function(kw) { return msgLower.includes(kw); });

        // Check pending deal
        var pendingDeal = null;
        if (history.length > 0) {
          for (var ph = history.length - 1; ph >= 0; ph--) {
            if (history[ph].role === 'user') {
              var phIntent = detectIntent(history[ph].content);
              if (phIntent.currency && phIntent.amount) {
                if (history.length - ph <= 10) { pendingDeal = { currency: phIntent.currency, amount: phIntent.amount, direction: phIntent.direction || 'sell' }; break; }
              }
            }
          }
        }

        // Build rates summary
        var ratesSummary = Object.entries(rates).map(function(e) { return e[0] + ' buy=' + e[1].buy + ' sell=' + e[1].sell; }).join(', ');

        // Build Claude messages
        var claudeMessages = history.slice(-10);
        var userContent = 'Customer name: ' + senderName + '\n';
        userContent += 'Time: ' + new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) + ' Nairobi time\n';
        userContent += 'Live rates: ' + ratesSummary + '\n';
        if (calculation) userContent += 'CALCULATION RESULT: Customer wants to ' + calculation.direction + ' ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + '. Rate: ' + calculation.rate + ' KES. Total: KSh ' + calculation.kes.toLocaleString() + '. VIP: ' + calculation.isVip + '\n';
        if (pendingDeal && (!calculation || pendingDeal.currency !== (calculation && calculation.currency))) {
          userContent += 'PENDING DEAL: ' + pendingDeal.direction + ' ' + String(pendingDeal.amount) + ' ' + pendingDeal.currency + ' - follow up naturally\n';
        }
        userContent += 'Customer message: ' + currentMessage;
        claudeMessages.push({ role: 'user', content: userContent });

        var system = 'You are Hassan, a warm witty persuasive forex sales assistant at AfriDesk Forex Bureau Nairobi Kenya. Hours Mon-Sat 8AM-5PM Sunday 8AM-3PM. Branches Standard Street CBD and Wabera Street CBD. Phone +254787510515. CRITICAL: You MUST respond with ONLY a valid JSON object. No text before or after the JSON. No markdown formatting. RULES: 1 Reply in same language as customer English Swahili Sheng Somali. 2 Use customer name naturally. 3 NEVER calculate rates yourself use CALCULATION RESULT only. 4 When customer bargains set is_bargain true and tell senior dealer will contact. 5 When customer accepts give branch instructions. 6 When VIP true tell senior dealer will contact personally for preferential rate. 7 Create urgency rates change every hour. 8 Follow up on PENDING DEAL naturally. 9 Be warm sales advisor not robotic. 10 For complaints apologize sincerely and escalate to manager. RESPOND ONLY WITH THIS JSON: {"intent":"greeting or rates or exchange or bargain or complaint or other","direction":"buy or sell or null","currency":"USD or EUR or GBP or AED or CNY or CAD or AUD or CHF or SAR or INR or null","amount":null,"is_vip":false,"is_bargain":false,"reply":"your natural response here"}';

        var claudeRaw = await callClaude(claudeMessages, system);
        console.log('Claude raw:', claudeRaw.substring(0, 100));

        var aiData = parseClaudeResponse(claudeRaw);
        var reply;
        if (!aiData) {
          var rawClean = claudeRaw ? claudeRaw.trim() : '';
          if (rawClean.length > 10 && !rawClean.startsWith('{')) {
            reply = rawClean;
            aiData = { is_vip: false, is_bargain: false };
          } else {
            reply = 'Karibu AfriDesk! How can I help you today?';
            aiData = { is_vip: false, is_bargain: false };
          }
        } else {
          reply = String(aiData.reply || 'Karibu AfriDesk! How can I help you today?');
        }

        if (reply.trim().startsWith('{') || reply.includes('"intent"')) {
          reply = 'Karibu AfriDesk! How can I help you today?';
        }

        var isVip = (calculation && calculation.isVip) || aiData.is_vip === true;
        var isBargain = aiData.is_bargain === true || nodeDetectedBargain;

        // Save history
        var updatedHistory = history.slice();
        updatedHistory.push({ role: 'user', content: currentMessage });
        updatedHistory.push({ role: 'assistant', content: reply });
        await saveHistory(customerId, updatedHistory, String(conversationId));

        // VIP alert
        if (isVip) {
          var tellerNote = 'VIP ENQUIRY\nCustomer: ' + senderName + (customerPhone ? '\nPhone: ' + customerPhone : '') + '\nCurrency: ' + (calculation ? calculation.currency : '?') + '\nAmount: ' + (calculation ? calculation.amount.toLocaleString() : 'Large') + '\nValue: KSh ' + (calculation ? calculation.kes.toLocaleString() : '?') + '\n"' + currentMessage + '"\nContact customer for preferential rate NOW!';
          await sendChatwootMessage(conversationId, tellerNote, true);
          await assignConversationToTeller(conversationId);
          await sendChatwootMessage('8', 'VIP ALERT! ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' wants to ' + (calculation ? calculation.direction + ' ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + ' = KSh ' + calculation.kes.toLocaleString() : 'large transaction') + '. Contact NOW!', false);
          var vipSMS = 'VIP ALERT! ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' wants to ' + (calculation ? calculation.direction + ' ' + calculation.amount.toLocaleString() + ' ' + calculation.currency : 'large transaction') + '. Contact NOW! -AfriDesk';
          await sendSMS(TELLER_PHONE, vipSMS);
          if (calculation && calculation.amount >= 10000) {
            await makeVoiceCall(TELLER_PHONE, 'Alert. VIP customer ' + senderName + ' needs assistance. Amount ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + '. Please open Chatwoot immediately.');
          }
          console.log('VIP alert sent!');
        }

        // Bargain alert
        if (isBargain && !isVip) {
          var bargainNote = 'BARGAIN REQUEST\nCustomer: ' + senderName + (customerPhone ? '\nPhone: ' + customerPhone : '') + '\nCurrency: ' + (calculation ? calculation.currency : '?') + '\nAmount: ' + (calculation ? calculation.amount.toLocaleString() : 'Unknown') + '\n"' + currentMessage + '"\nCustomer is negotiating - senior dealer should contact ASAP!';
          await sendChatwootMessage(conversationId, bargainNote, true);
          await assignConversationToTeller(conversationId);
          await sendChatwootMessage('8', 'BARGAIN ALERT! ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' is negotiating rates. Contact ASAP! -AfriDesk', false);
          await sendSMS(TELLER_PHONE, 'BARGAIN ALERT! Customer ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' is negotiating. Contact ASAP! -AfriDesk');
          console.log('Bargain alert sent!');
        }

        // Acceptance alert
        if (nodeDetectedAcceptance && calculation) {
          var acceptNote = 'TRANSACTION CONFIRMED!\nCustomer: ' + senderName + (customerPhone ? '\nPhone: ' + customerPhone : '') + '\nCurrency: ' + calculation.currency + '\nAmount: ' + calculation.amount.toLocaleString() + '\nValue: KSh ' + calculation.kes.toLocaleString() + '\n"' + currentMessage + '"\nCustomer is COMING IN - prepare the transaction NOW!';
          await sendChatwootMessage(conversationId, acceptNote, true);
          await assignConversationToTeller(conversationId);
          await sendSMS(TELLER_PHONE, 'CONFIRMED! ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' is coming to transact ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + ' = KSh ' + calculation.kes.toLocaleString() + '. Prepare NOW! -AfriDesk');
          console.log('Acceptance alert sent!');
        }

        // Complaint alert
        if (nodeDetectedComplaint) {
          var complaintNote = 'CUSTOMER COMPLAINT\nCustomer: ' + senderName + (customerPhone ? '\nPhone: ' + customerPhone : '') + '\n"' + currentMessage + '"\nURGENT: Manager must contact customer immediately!';
          await sendChatwootMessage(conversationId, complaintNote, true);
          await assignConversationToTeller(conversationId);
          await sendSMS(TELLER_PHONE, 'COMPLAINT! Customer ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' - "' + currentMessage.substring(0, 80) + '" - Contact IMMEDIATELY! -AfriDesk');
          console.log('Complaint alert sent!');
        }

        await sendChatwootMessage(conversationId, reply, false);
        console.log('Sent:', reply.substring(0, 80));

      } catch(err) { console.error('Error:', err.message); }
    });
  } else { res.writeHead(200); res.end('OK'); }
});

var PORT = process.env.PORT || 3000;
server.listen(PORT, async function() {
  console.log('AfriDesk API starting on port ' + PORT);
  await setupDB();
  console.log('AfriDesk Ready!');

  if (GOOGLE_SHEET_URL) {
    setInterval(async function() {
      try {
        var sheetRates = await fetchRatesFromSheet();
        if (Object.keys(sheetRates).length > 0) {
          for (var cur in sheetRates) {
            await queryDB('INSERT INTO rates (currency, buy_rate, sell_rate, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (currency) DO UPDATE SET buy_rate=$2, sell_rate=$3, updated_at=NOW()', [cur, sheetRates[cur].buy, sheetRates[cur].sell]);
          }
          console.log('Rates synced from Google Sheet');
        }
      } catch(e) { console.log('Rate sync error:', e.message); }
    }, 5 * 60 * 1000);
  }

  function scheduleMorningBroadcast() {
    var now = new Date();
    var nairobi = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
    var nextBroadcast = new Date(nairobi);
    nextBroadcast.setHours(9, 0, 0, 0);
    if (nairobi.getHours() >= 9) nextBroadcast.setDate(nextBroadcast.getDate() + 1);
    var msUntilBroadcast = nextBroadcast - nairobi;
    console.log('Morning broadcast scheduled in', Math.round(msUntilBroadcast / 60000), 'minutes');
    setTimeout(async function() {
      if (isBusinessOpen()) await sendMorningBroadcast();
      scheduleMorningBroadcast();
    }, msUntilBroadcast);
  }
  scheduleMorningBroadcast();
  console.log('Morning broadcast scheduler started!');
});
