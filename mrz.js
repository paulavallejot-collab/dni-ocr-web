/* mrz.js — Validación MRZ (TD1) conforme a ICAO 9303 */
const MRZ_WEIGHTS = [7,3,1];
function mrzCharValue(ch){
  if (ch === '<') return 0;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - '0'.charCodeAt(0);
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return 10 + (code - 65);
  return 0;
}
function computeCheckDigit(field){
  let sum = 0;
  for (let i = 0; i < field.length; i++){
    sum += mrzCharValue(field[i]) * MRZ_WEIGHTS[i % 3];
  }
  return (sum % 10).toString();
}
function cleanMRZLines(ocrText){
  const lines = ocrText.split(/\r?\n/).map(l=> l.trim().replace(/\s+/g,''));
  const candidates = lines.filter(l=> l.length >= 28 && (l.match(/</g)||[]).length >= 5).sort((a,b)=> b.length - a.length);
  let L1 = candidates[0] || '';
  let L2 = candidates[1] || '';
  let L3 = candidates[2] || '';
  [L1,L2,L3] = [L1,L2,L3].map(s=>{ s = s.slice(0,30); return s.padEnd(30,'<'); });
  return { L1, L2, L3 };
}
const TD1_LINE1 = /^([A-Z0-9<])([A-Z]{3})([A-Z0-9<]{9})([0-9])([A-Z0-9<]{16})$/;
const TD1_LINE2 = /^([0-9]{6})([0-9])([MF<])([0-9]{6})([0-9])([A-Z]{3})([A-Z0-9<]{11})([0-9])$/;
function parseTD1(L1,L2,L3){
  const m1 = L1.match(TD1_LINE1);
  const m2 = L2.match(TD1_LINE2);
  if (!m1 || !m2){ return { ok:false, error:'No coincide con TD1 (3 líneas × 30 caracteres).'}; }
  const docType = m1[1], issuer = m1[2], docNumber = m1[3], docCheck = m1[4], opt1 = m1[5];
  const birth = m2[1], birthCheck = m2[2], sex = m2[3], expiry = m2[4], expCheck = m2[5], nation = m2[6], opt2 = m2[7], composite = m2[8];
  const parts = L3.split('<<');
  const surnames = (parts[0]||'').replace(/</g,' ').replace(/\s+/g,' ').trim();
  const names    = (parts.slice(1).join(' ')||'').replace(/</g,' ').replace(/\s+/g,' ').trim();
  return { ok:true, raw:{L1,L2,L3}, fields:{ docType, issuer, docNumber, docCheck, opt1, birth, birthCheck, sex, expiry, expCheck, nation, opt2, composite, surnames, names } };
}
function verifyTD1Checks(fields){
  const docOk = computeCheckDigit(fields.docNumber) === fields.docCheck;
  const birthOk = computeCheckDigit(fields.birth) === fields.birthCheck;
  const expOk = computeCheckDigit(fields.expiry) === fields.expCheck;
  const compositeSource = fields.docNumber + fields.docCheck + fields.birth + fields.birthCheck + fields.expiry + fields.expCheck + fields.opt1 + fields.opt2;
  const compOk = computeCheckDigit(compositeSource) === fields.composite;
  return { docOk, birthOk, expOk, compOk, allOk:(docOk && birthOk && expOk && compOk) };
}
export function validateMRZfromOCR(ocrText){
  const { L1,L2,L3 } = cleanMRZLines(ocrText);
  const parsed = parseTD1(L1,L2,L3);
  if (!parsed.ok) return { ok:false, error:parsed.error, detail:{L1,L2,L3} };
  const checks = verifyTD1Checks(parsed.fields);
  return { ok: checks.allOk, fields: parsed.fields, checks, detail: parsed.raw };
}
