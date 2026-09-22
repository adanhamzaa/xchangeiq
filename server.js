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
const MOBILESASA_TOKEN = process.env.MOBILESASA_TOKEN;
const TELLER_WHATSAPP = process.env.TELLER_WHATSAPP || process.env.TELLER_PHONE;
const TELLER_AGENT_ID = process.env.TELLER_AGENT_ID || '2';
const VIP_THRESHOLD_KES = parseInt(process.env.VIP_THRESHOLD_KES || '650000');

function assignConversationToTeller(conversationId) {
  return new Promise(function(resolve) {
    if (!CHATWOOT_TOKEN || !conversationId) return resolve(null);
    
    var body = JSON.stringify({ assignee_id: parseInt(TELLER_AGENT_ID) });
    var options = {
      hostname: CHATWOOT_URL,
      path: '/api/v1/accounts/1/conversations/' + conversationId + '/assignments',
      method: 'POST',
      headers: {
        'api_access_token': CHATWOOT_TOKEN,
        'Content-Type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };
    
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        console.log('Conversation assigned to teller! ID:', conversationId);
        resolve(true);
      });
    });
    req.on('error', function(e) {
      console.log('Assignment error:', e.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// Get active customers from last 24 hours
async function getActiveCustomers() {
  try {
    var result = await queryDB(
      "SELECT customer_id, messages FROM conversations WHERE updated_at > NOW() - INTERVAL '24 hours'" 
    );
    return result.rows || [];
  } catch(e) {
    console.log('Get active customers error:', e.message);
    return [];
  }
}

// Send morning rates broadcast to active customers
async function sendMorningBroadcast() {
  try {
    var nairobi = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    console.log('Morning broadcast starting:', nairobi);

    // Get current rates
    var rates = await getRates();
    var today = new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Nairobi' });
    var rateMsg = 'Habari za asubuhi! Good morning! Karibu AfriDesk Forex Bureau. ' + today + '\n\n';
    rateMsg += 'Hizi ndizo rates za leo:\n\n';
    if (rates.USD) rateMsg += 'USD (Dollar)\nBuy: ' + rates.USD.buy + ' | Sell: ' + rates.USD.sell + '\n\n';
    if (rates.EUR) rateMsg += 'EUR (Euro)\nBuy: ' + rates.EUR.buy + ' | Sell: ' + rates.EUR.sell + '\n\n';
    if (rates.GBP) rateMsg += 'GBP (Pound)\nBuy: ' + rates.GBP.buy + ' | Sell: ' + rates.GBP.sell + '\n\n';
    if (rates.AED) rateMsg += 'AED (Dirham)\nBuy: ' + rates.AED.buy + ' | Sell: ' + rates.AED.sell + '\n\n';
    if (rates.CNY) rateMsg += 'CNY (Yuan)\nBuy: ' + rates.CNY.buy + ' | Sell: ' + rates.CNY.sell + '\n\n';
    if (rates.CHF) rateMsg += 'CHF (Swiss Franc)\nBuy: ' + rates.CHF.buy + ' | Sell: ' + rates.CHF.sell + '\n\n';
    if (rates.SAR) rateMsg += 'SAR (Saudi Riyal)\nBuy: ' + rates.SAR.buy + ' | Sell: ' + rates.SAR.sell + '\n\n';
    if (rates.INR) rateMsg += 'INR (Rupee)\nBuy: ' + rates.INR.buy + ' | Sell: ' + rates.INR.sell + '\n\n';
    rateMsg += 'Tuna matawi mawili:\n';
    rateMsg += 'Standard Street CBD na Wabera Street CBD\n\n';
    rateMsg += 'Tunafungua: Mon-Sat 8AM-5PM | Sun 8AM-3PM\n';
    rateMsg += 'Simu: +254787510515\n\n';
    rateMsg += 'Karibu sana! Have a productive day!';   // Get active customers
    var customers = await getActiveCustomers();
    console.log('Active customers to broadcast:', customers.length);

    // Send to each active customer via Chatwoot
    var sent = 0;
    for (var i = 0; i < customers.length; i++) {
      var customerId = customers[i].customer_id;
      try {
        // Find their Chatwoot conversation
        var convResult = await queryDB(
          'SELECT conversation_id FROM conversations WHERE customer_id=$1 AND conversation_id IS NOT NULL',
          [customerId]
        );
        if (convResult.rows.length > 0 && convResult.rows[0].conversation_id) {
          await sendChatwootMessage(convResult.rows[0].conversation_id, rateMsg, false);
          sent++;
          // Small delay to avoid rate limiting
          await new Promise(function(r) { setTimeout(r, 500); });
        }
      } catch(e) {
        console.log('Broadcast error for customer:', customerId, e.message);
      }
    }
    console.log('Morning broadcast complete! Sent to:', sent, 'customers');
  } catch(e) {
    console.log('Morning broadcast failed:', e.message);
  }
}

function makeVoiceCall(phone, message) {
  return new Promise(function(resolve) {
    if (!AT_API_KEY || !phone) {
      console.log('Voice call not configured - skipping');
      return resolve(null);
    }

    var callUrl = 'https://xchangeiq-production.up.railway.app/voice-alert';
    var body = 'username=' + encodeURIComponent(AT_USERNAME) +
      '&to=' + encodeURIComponent(phone) +
      '&from=' + encodeURIComponent(process.env.AT_CALLER_ID || '') +
      '&callActions=' + encodeURIComponent(JSON.stringify([{
        say: { text: message, voice: 'woman', playBeep: false }
      }]));

    var hostname = AT_USERNAME === 'sandbox' ? 'voice.sandbox.africastalking.com' : 'voice.africastalking.com';
    
    var callBody = 'username=' + encodeURIComponent(AT_USERNAME) +
      '&to=' + encodeURIComponent(phone);

    var options = {
      hostname: hostname,
      path: '/call',
      method: 'POST',
      headers: {
        'apiKey': AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(callBody)
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        console.log('Voice call initiated! Response:', data.substring(0, 100));
        resolve(data);
      });
    });
    req.on('error', function(err) {
      console.log('Voice call error:', err.message);
      resolve(null);
    });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.write(callBody);
    req.end();
  });
}

function sendWhatsAppToTeller(phone, message) {
  return new Promise(function(resolve) {
    if (!CHATWOOT_TOKEN || !phone) return resolve(null);

    // Step 1: Search for contact by phone
    var cleanPhone = phone.replace(/\s/g, '');
    var searchPath = '/api/v1/accounts/1/contacts/search?q=' + encodeURIComponent(cleanPhone) + '&include_contacts=true';
    
    var searchOptions = {
      hostname: CHATWOOT_URL,
      path: searchPath,
      method: 'GET',
      headers: { 'api_access_token': CHATWOOT_TOKEN }
    };

    https.request(searchOptions, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var result = JSON.parse(data);
          var contacts = result.payload || [];
          var contact = contacts.find(function(c) {
            return c.phone_number && c.phone_number.replace(/\s/g, '').includes(cleanPhone.replace('+', ''));
          });
          
          if (!contact) {
            console.log('Teller contact not found:', cleanPhone);
            return resolve(null);
          }

          // Step 2: Find open conversation with this contact
          var convSearchPath = '/api/v1/accounts/1/contacts/' + contact.id + '/conversations';
          https.request({
            hostname: CHATWOOT_URL,
            path: convSearchPath,
            method: 'GET',
            headers: { 'api_access_token': CHATWOOT_TOKEN }
          }, function(r) {
            var d = '';
            r.on('data', function(c) { d += c; });
            r.on('end', function() {
              try {
                var convResult = JSON.parse(d);
                var conversations = (convResult.data && convResult.data.payload) || convResult.payload || [];
                var openConv = conversations.find(function(c) { return c.status === 'open'; });
                
                if (openConv) {
                  // Send message to existing open conversation
                  var msgBody = JSON.stringify({
                    content: message,
                    message_type: 'outgoing',
                    private: false
                  });
                  https.request({
                    hostname: CHATWOOT_URL,
                    path: '/api/v1/accounts/1/conversations/' + openConv.id + '/messages',
                    method: 'POST',
                    headers: {
                      'api_access_token': CHATWOOT_TOKEN,
                      'Content-Type': 'application/json',
                      'content-length': Buffer.byteLength(msgBody)
                    }
                  }, function(mr) {
                    mr.on('data', function() {});
                    mr.on('end', function() {
                      console.log('WhatsApp teller alert sent to conversation', openConv.id);
                      resolve(true);
                    });
                  }).on('error', resolve).end(msgBody);
                } else {
                  console.log('No open conversation with teller - creating new one');
                  // Create new conversation
                  var newConvBody = JSON.stringify({
                    inbox_id: 1,
                    contact_id: contact.id,
                    additional_attributes: {},
                    message: { content: message }
                  });
                  https.request({
                    hostname: CHATWOOT_URL,
                    path: '/api/v1/accounts/1/conversations',
                    method: 'POST',
                    headers: {
                      'api_access_token': CHATWOOT_TOKEN,
                      'Content-Type': 'application/json',
                      'content-length': Buffer.byteLength(newConvBody)
                    }
                  }, function(nr) {
                    nr.on('data', function() {});
                    nr.on('end', function() {
                      console.log('New teller conversation created');
                      resolve(true);
                    });
                  }).on('error', resolve).end(newConvBody);
                }
              } catch(e) {
                console.log('Conv search error:', e.message);
                resolve(null);
              }
            });
          }).on('error', resolve).end();
        } catch(e) {
          console.log('Contact search error:', e.message);
          resolve(null);
        }
      });
    }).on('error', resolve).end();
  });
}

function sendSMS(phone, message) {
  return new Promise(function(resolve) {
    if (!phone) {
      console.log('SMS not configured - skipping');
      return resolve(null);
    }

    // Use Mobile Sasa if token available, otherwise Africa's Talking
    if (MOBILESASA_TOKEN) {
      var body = JSON.stringify({
        senderID: 'MOBILESASA',
        phone: phone,
        message: message
      });

      var options = {
        hostname: 'api.mobilesasa.com',
        path: '/v1/send/message',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + MOBILESASA_TOKEN,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      var req = https.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          console.log('Mobile Sasa SMS sent! Response:', data.substring(0, 100));
          resolve(data);
        });
      });
      req.on('error', function(err) {
        console.log('Mobile Sasa SMS error:', err.message);
        resolve(null);
      });
      setTimeout(function() { req.destroy(); resolve(null); }, 10000);
      req.write(body);
      req.end();

    } else if (AT_API_KEY) {
      var atBody = 'username=' + encodeURIComponent(AT_USERNAME) +
        '&to=' + encodeURIComponent(phone) +
        '&message=' + encodeURIComponent(message);

      var atOptions = {
        hostname: AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com',
        path: '/version1/messaging',
        method: 'POST',
        headers: {
          'apiKey': AT_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(atBody)
        }
      };

      var atReq = https.request(atOptions, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          console.log('AT SMS sent! Response:', data.substring(0, 100));
          resolve(data);
        });
      });
      atReq.on('error', function(err) {
        console.log('AT SMS error:', err.message);
        resolve(null);
      });
      setTimeout(function() { atReq.destroy(); resolve(null); }, 10000);
      atReq.write(atBody);
      atReq.end();
    } else {
      console.log('No SMS provider configured');
      resolve(null);
    }
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
        conversation_id VARCHAR(100),
        messages JSONB DEFAULT '[]',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await queryDB('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(100)').catch(function(){});
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
        var customerPhone = String((payload.sender && payload.sender.phone_number) || '');

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

        // NODE.JS BARGAIN DETECTION - more reliable than Claude
        var bargainKeywords = [
          'better rate', 'cheaper', 'negotiate', 'negotiating', 'discount',
          'can you do', 'beat that', 'match the rate', 'match their rate',
          'other bureau', 'competitor', 'offered me', 'giving me',
          'last price', 'best price', 'reduce', 'lower rate', 'improve',
          'too low', 'too high', 'not good enough', 'elsewhere',
          'another place', 'down a bit', 'little more', 'kidogo zaidi',
          'punguza', 'bei nzuri', 'wanipe', 'wanapea', 'wameniambia'
        ];

        // COMPLAINT DETECTION
        var complaintKeywords = [
          'complaint', 'complain', 'unhappy', 'disappointed', 'terrible',
          'worst', 'bad service', 'fraud', 'cheat', 'cheated', 'scam',
          'scammed', 'lied', 'wrong rate', 'wrong amount', 'overcharged',
          'report', 'police', 'lawyer', 'sue', 'legal', 'manager',
          'supervisor', 'refund', 'money back', 'return my money',
          'never coming back', 'lost money', 'stole', 'stolen',
          'malalamiko', 'nimedanganywa', 'vibaya', 'hasara', 'pesa yangu',
          'rejesha', 'rudisha', 'nimeibiwa', 'wizi'
        ];

        // ACCEPTANCE DETECTION
        var acceptanceKeywords = [
          'i accept', 'i agree', 'deal', 'ok i will come', 'i will come',
          'on my way', 'coming now', 'coming today', 'i am coming',
          'nataka kuja', 'nakuja', 'sawa', 'nimekubali', 'done deal',
          'lets do it', "let's do it", 'yes i confirm', 'confirmed',
          'book it', 'lock it', 'proceed', 'go ahead', 'yes proceed',
          'i will take it', 'take it', 'accept the rate', 'ok deal',
          'see you', 'heading there', 'on the way', 'coming over'
        ];

        var msgLower = currentMessage.toLowerCase();
        var nodeDetectedBargain = bargainKeywords.some(function(kw) {
          return msgLower.includes(kw);
        });
        var nodeDetectedComplaint = complaintKeywords.some(function(kw) {
          return msgLower.includes(kw);
        });
        var nodeDetectedAcceptance = acceptanceKeywords.some(function(kw) {
          return msgLower.includes(kw);
        });

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
            isVip: (intent.amount * rate.buy) >= VIP_THRESHOLD_KES
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
        // Check for pending deals in history
        var pendingDeal = null;
        if (history.length > 0) {
          for (var ph = history.length - 1; ph >= 0; ph--) {
            if (history[ph].role === 'user') {
              var phIntent = detectIntent(history[ph].content);
              if (phIntent.currency && phIntent.amount) {
                var phTime = history.length - ph;
                if (phTime <= 10) { // Within last 5 exchanges
                  pendingDeal = {
                    currency: phIntent.currency,
                    amount: phIntent.amount,
                    direction: phIntent.direction || 'sell',
                    message: history[ph].content
                  };
                  break;
                }
              }
            }
          }
        }

        if (pendingDeal && (!calculation || pendingDeal.currency !== (calculation && calculation.currency))) {
          userContent += 'PENDING DEAL: ' + pendingDeal.direction + ' ' + String(pendingDeal.amount) + ' ' + pendingDeal.currency + ' - follow up naturally';
        }
        userContent += 'Customer message: ' + currentMessage;

        claudeMessages.push({ role: 'user', content: userContent });

        var system = 'You are Hassan, a warm witty and persuasive forex assistant at AfriDesk Forex Bureau, Nairobi Kenya. You are also a skilled sales closer who never lets a deal slip away. BUSINESS INFO: Hours: Monday-Saturday 8AM-5PM, Sunday 8AM-3PM. Branches: Standard Street CBD and Wabera Street CBD. Phone: +254787510515.\n\nCORE RULES:\n1. Always respond with ONLY valid JSON - nothing else\n2. Use customer name naturally\n3. Reply in same language as customer (English/Swahili/Sheng/Somali)\n4. Use conversation history - never ask for info already given\n5. NEVER calculate rates yourself - use CALCULATION RESULT if provided\n6. Share CALCULATION RESULT numbers naturally\n\nRATE DIRECTION RULES:\n7. Customer SELLING foreign currency (has USD/EUR/CNY wants KES) = they get BUY rate\n8. Customer BUYING foreign currency (wants USD/EUR/CNY pays KES) = they pay SELL rate\n9. NEVER agree to a rate the customer requests. If customer asks can I get 130 for USD reply: Our current buy rate is 128.5 - our senior dealer will confirm the best possible rate for your amount\n10. Never promise to match competitor rates - always escalate to dealer\n\nSALES RULES:\n11. When customer mentions competitor rate - acknowledge then create urgency and escalate\n12. Create urgency naturally - rates change every hour\n13. Offer to connect customer with senior dealer for better rate\n14. Be trusted advisor not pushy salesman\n\nBARGAINING RULES:\n15. If customer insists on better rate or bargains - set is_bargain to true\n16. Tell customer senior dealer will contact them personally\n17. Always make customer feel valued and important\n\nVIP RULES:\n18. VIP: true means senior teller will contact for preferential rate\n19. Large amounts always deserve personal attention\n\nCLOSING RULES:\n20. After providing calculation or completing an exchange inquiry always end with a warm closing: mention our branches (Standard Street CBD or Wabera Street CBD) naturally\n21. After transaction calculation say: Our senior dealer will contact you shortly to confirm and finalize your transaction\n22. Always make customer feel valued - they are not just a transaction\n\nACCEPTANCE RULES:\n23. When customer confirms they are coming or accepts the deal - celebrate warmly and give them clear instructions\n24. Tell them exactly which branch to go to and what to bring - ID and the currency\n25. Confirm the rate and amount one more time so they are clear\n26. Example: Amazing Hamza! Come to Standard Street CBD with your USD and your ID. Ask for the senior dealer - everything will be ready for you!\n\nCOMPLAINT RULES:\n27. If customer complains about service, wrong rate, or lost money - be extremely apologetic and empathetic\n28. Immediately assure them a manager will contact them urgently\n29. Never argue or dismiss a complaint - take it seriously\n30. Say: I am deeply sorry for this experience. I am escalating this to our manager RIGHT NOW as urgent priority.\n\nFOLLOW-UP RULES:\n23. Check conversation history for any PENDING deals or previous rate inquiries\n24. If customer asked about a transaction earlier but never confirmed - follow up naturally: example: By the way you mentioned selling 10000 USD earlier - did you manage to sort that out? Our dealer is still available!\n25. If customer switches to a new currency inquiry - acknowledge it AND follow up on previous inquiry\n26. Never let a deal die silently - always check if previous inquiry was resolved\n27. If customer has been asking multiple questions - summarize and push for decision: You have asked about USD EUR and GBP today - which one shall we process first?\n28. Create gentle urgency: Rates change every hour - shall we lock this in now?\n\nJSON FORMAT:\n{"intent":"greeting|rates|exchange|smalltalk|bargain|other","direction":"buy|sell|null","currency":"USD|EUR|GBP|AED|CNY|CAD|AUD|INR|null","amount":null,"is_vip":false,"is_bargain":false,"reply":"your natural response"}';


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
        var isBargain = aiData.is_bargain === true || nodeDetectedBargain;
        if (nodeDetectedBargain) console.log('Node.js detected bargain!');

        // Save to history including conversation_id
        var updatedHistory = history.slice();
        updatedHistory.push({ role: 'user', content: currentMessage });
        updatedHistory.push({ role: 'assistant', content: reply });
        await saveHistory(customerId, updatedHistory);
        // Save conversation_id for broadcast
        try {
          await queryDB(
            'UPDATE conversations SET conversation_id=$1 WHERE customer_id=$2',
            [conversationId, customerId]
          );
        } catch(e) {}

        // Send VIP teller alert
        if (isVip) {
          var tellerNote = '🚨 VIP ENQUIRY\n👤 Customer: ' + senderName + (customerPhone ? '\n📞 Phone: ' + customerPhone : '') + '\n💱 Currency: ' + (calculation ? calculation.currency : aiData.currency || '?') + '\n💰 Amount: ' + (calculation ? calculation.amount.toLocaleString() : 'Large amount') + '\n💵 Value: KSh ' + (calculation ? calculation.kes.toLocaleString() : '?') + '\n📝 "' + currentMessage + '"\n✅ Contact customer for preferential rate NOW!';
          await sendChatwootMessage(conversationId, tellerNote, true);
          // Assign conversation to teller - triggers Chatwoot push notification
          await assignConversationToTeller(conversationId);
          // SMS alert to teller
          var vipSMS = '🚨 VIP! ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' wants to ' + (calculation ? calculation.direction + ' ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + ' = KSh ' + calculation.kes.toLocaleString() : 'large transaction') + '. Call NOW! -AfriDesk';
          await sendSMS(TELLER_PHONE, vipSMS);
          await sendWhatsAppToTeller(TELLER_WHATSAPP, tellerNote);
          // Voice call for high value VIP
          if (calculation && calculation.amount >= 10000) {
            var voiceMsg = 'Alert! A high value VIP customer needs assistance. Amount: ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + '. Please open Chatwoot immediately.';
            await makeVoiceCall(TELLER_PHONE, voiceMsg);
          }
          console.log('VIP alert sent!');
        }

        // Send BARGAIN alert when customer negotiates
        if (isBargain && !isVip) {
          var bargainNote = '💬 BARGAIN REQUEST\n👤 Customer: ' + senderName + (customerPhone ? '\n📞 Phone: ' + customerPhone : '') + '\n💱 Currency: ' + (calculation ? calculation.currency : aiData.currency || '?') + '\n💰 Amount: ' + (calculation ? calculation.amount.toLocaleString() : 'Unknown') + '\n📝 "' + currentMessage + '"\n⚡ Customer is negotiating — senior dealer should contact ASAP!';
          await sendChatwootMessage(conversationId, bargainNote, true);
          await assignConversationToTeller(conversationId);
          var bargainSMS = 'BARGAIN ALERT! Customer: ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' is negotiating. Contact ASAP! - AfriDesk';
          await sendSMS(TELLER_PHONE, bargainSMS);
          await sendWhatsAppToTeller(TELLER_WHATSAPP, bargainNote);
          console.log('Bargain alert sent!');
        }

        // Send ACCEPTANCE alert when customer confirms transaction
        if (nodeDetectedAcceptance && calculation) {
          var acceptNote = '✅ TRANSACTION CONFIRMED!\n👤 Customer: ' + senderName + (customerPhone ? '\n📞 Phone: ' + customerPhone : '') + '\n💱 Currency: ' + calculation.currency + '\n💰 Amount: ' + calculation.amount.toLocaleString() + '\n💵 Value: KSh ' + calculation.kes.toLocaleString() + '\n📝 "' + currentMessage + '"\n🏃 Customer is COMING IN — prepare the transaction NOW!';
          await sendChatwootMessage(conversationId, acceptNote, true);
          await assignConversationToTeller(conversationId);
          var acceptSMS = '✅ CONFIRMED! ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' is coming to transact ' + calculation.amount.toLocaleString() + ' ' + calculation.currency + ' = KSh ' + calculation.kes.toLocaleString() + '. Prepare NOW! - AfriDesk';
          await sendSMS(TELLER_PHONE, acceptSMS);
          await sendWhatsAppToTeller(TELLER_WHATSAPP, acceptNote);
          console.log('Acceptance alert sent!');
        }

        // Send COMPLAINT alert
        if (nodeDetectedComplaint) {
          var complaintNote = '🚨 CUSTOMER COMPLAINT\n👤 Customer: ' + senderName + (customerPhone ? '\n📞 Phone: ' + customerPhone : '') + '\n📝 "' + currentMessage + '"\n⚠️ URGENT: Manager must contact customer immediately!';
          await sendChatwootMessage(conversationId, complaintNote, true);
          await assignConversationToTeller(conversationId);
          var complaintSMS = '🚨 COMPLAINT! Customer: ' + senderName + (customerPhone ? ' ' + customerPhone : '') + ' - "' + currentMessage.substring(0, 80) + '" - Contact IMMEDIATELY! - AfriDesk';
          await sendSMS(TELLER_PHONE, complaintSMS);
          await sendWhatsAppToTeller(TELLER_WHATSAPP, complaintNote);
          console.log('Complaint alert sent!');
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

  // Morning broadcast at 9AM Nairobi time every day
  function scheduleMorningBroadcast() {
    var now = new Date();
    var nairobi = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
    var nextBroadcast = new Date(nairobi);
    nextBroadcast.setHours(9, 0, 0, 0);
    
    // If already past 9AM today, schedule for tomorrow
    if (nairobi.getHours() >= 9) {
      nextBroadcast.setDate(nextBroadcast.getDate() + 1);
    }
    
    var msUntilBroadcast = nextBroadcast - nairobi;
    console.log('Morning broadcast scheduled in', Math.round(msUntilBroadcast / 60000), 'minutes');
    
    setTimeout(async function() {
      // Only broadcast on business days
      if (isBusinessOpen()) {
        await sendMorningBroadcast();
      }
      // Schedule next day
      scheduleMorningBroadcast();
    }, msUntilBroadcast);
  }
  
  scheduleMorningBroadcast();
  console.log('Morning broadcast scheduler started!');

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
