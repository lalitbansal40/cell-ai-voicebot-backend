/**
 * NotifyNow → Google Sheet: appends one row per finished call (`call.completed`).
 *
 * Setup (docs/integrations/google-sheets.md):
 *  1. In the sheet: Extensions → Apps Script, paste this file, save.
 *  2. Project Settings → Script properties → add RECEIVER_KEY = a long random text
 *     (for example 32 letters and digits you make up).
 *  3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *  4. Add the web app URL + "?key=<RECEIVER_KEY>" in NotifyNow → Integrations →
 *     Webhooks with the event "call.completed".
 *
 * Kept in step with scripts/lib/sheets-receiver.ts (tested against the golden vectors).
 * Apps Script web apps can't read request headers, so NotifyNow's X-Webhook-Signature
 * can't be checked here: the secret `key` in the URL is the check instead (only you
 * and NotifyNow know the full URL). With a proxy that passes the headers, use
 * verifyRequest with WEBHOOK_SECRET. Repeats are dropped by event id.
 */

var COLUMNS = [
  'Received at',
  'Event id',
  'Call id',
  'External ref',
  'Status',
  'Outcome',
  'Duration (s)',
  'Cost (₹)',
  'Contact id',
];

function sameText(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hmacHex(key, message) {
  var bytes = Utilities.computeHmacSha256Signature(message, key);
  return bytes
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');
}

/** Same check as scripts/lib/sheets-receiver.ts verifyRequest (when headers are available). */
function verifyRequest(headers, rawBody, secret, nowSec) {
  var ts = Number(headers['x-webhook-timestamp']);
  if (!isFinite(ts) || Math.abs(nowSec - ts) > 300) return false;
  var expected = hmacHex(secret, String(ts) + '.' + rawBody);
  return String(headers['x-webhook-signature'] || '')
    .split(',')
    .map(function (p) {
      return p.trim().replace(/^v1=/, '');
    })
    .some(function (given) {
      return sameText(given, expected);
    });
}

function rowFor(rawBody, receivedAt) {
  var event = JSON.parse(rawBody);
  if (event.type !== 'call.completed') return null;
  var d = event.data || {};
  var str = function (v) {
    return typeof v === 'string' ? v : '';
  };
  var num = function (v) {
    return typeof v === 'number' ? v : 0;
  };
  return [
    receivedAt,
    event.id,
    str(d.callId),
    str(d.externalRef),
    str(d.status),
    str(d.disposition),
    num(d.durationSec),
    Math.round(num(d.costMicros) / 10000) / 100,
    str(d.contactId),
  ];
}

function doPost(e) {
  var expectedKey = PropertiesService.getScriptProperties().getProperty('RECEIVER_KEY') || '';
  var givenKey = (e.parameter && e.parameter.key) || '';
  if (!expectedKey || !sameText(givenKey, expectedKey)) {
    return ContentService.createTextOutput('forbidden');
  }
  var raw = e.postData ? e.postData.contents : '';
  var row = rowFor(raw, new Date().toISOString());
  if (!row) return ContentService.createTextOutput('ignored');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) sheet.appendRow(COLUMNS);
  // de-duplicate on the event id (deliveries are at-least-once)
  var ids =
    sheet.getLastRow() > 1 ? sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues() : [];
  for (var i = 0; i < ids.length; i += 1) {
    if (ids[i][0] === row[1]) return ContentService.createTextOutput('duplicate');
  }
  sheet.appendRow(row);
  return ContentService.createTextOutput('ok');
}
