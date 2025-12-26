// Estado y utilidades
const CSV_URL = 'data/convocatoria.csv';
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
let attendees = [];
let logs = JSON.parse(localStorage.getItem('logs') || '[]');
let incidents = JSON.parse(localStorage.getItem('incidents') || '[]');
let stream = null;
let mrzState = { status: 'init', checks: null };

function csvToJSON(csvText){
  const lines = csvText.trim().split(/\r?\n/);
  const headers = lines.shift().split(',').map(h=>h.trim());
  return lines.map(l=>{
    const cols = l.split(',');
    const obj={};
    headers.forEach((h,i)=> obj[h] = (cols[i]||'').trim());
    return obj;
  });
}
function normalizeDNI(s){ return (s||'').toUpperCase().replace(/\s+/g,'').replace(/-/g,'').replace(/[\.]/g,'').trim(); }
function isValidDNISpain(dni){
  const m = dni.match(/^(\d{8})([A-Z])$/);
  if(!m) return false;
  const num = parseInt(m[1],10);
  const expected = DNI_LETTERS[num % 23];
  return m[2] === expected;
}
function downloadCSV(filename, rows, headers){
  const csv = [headers.join(',')].concat(rows.map(r=> headers.map(h=> (r[h]??'')).join(','))).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function setCounts(){
  document.getElementById('counts').textContent = `Validados: ${logs.length} · Incidencias: ${incidents.length}`;
  localStorage.setItem('logs', JSON.stringify(logs));
  localStorage.setItem('incidents', JSON.stringify(incidents));
}

// Cámara
const videoEl = document.getElementById('video');
const canvasEl = document.getElementById('canvas');
const procCanvasEl = document.getElementById('procCanvas');
const snapImg = document.getElementById('snapshot');
const startBtn = document.getElementById('startCamBtn');
const stopBtn = document.getElementById('stopCamBtn');
const capBtn  = document.getElementById('captureBtn');

startBtn.onclick = async ()=>{
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: {ideal:1280}, height:{ideal:720} },
      audio:false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    capBtn.disabled = false; stopBtn.disabled = false;
  } catch(err){
    alert('No se pudo acceder a la cámara: ' + err.message);
  }
};

stopBtn.onclick = ()=>{
  if(stream){ stream.getTracks().forEach(t=> t.stop()); }
  videoEl.srcObject = null;
  capBtn.disabled = true; stopBtn.disabled = true;
};

// Preprocesado: grayscale + contraste + umbral
function preprocessImage(srcCanvas, dstCanvas, opts = { contrast: 1.4, threshold: 150 }) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  dstCanvas.width = sw; dstCanvas.height = sh;
  const sctx = srcCanvas.getContext('2d');
  const dctx = dstCanvas.getContext('2d');
  const imgData = sctx.getImageData(0, 0, sw, sh);
  const data = imgData.data;
  // Grayscale
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const y = 0.299*r + 0.587*g + 0.114*b;
    data[i] = data[i+1] = data[i+2] = y;
  }
  // Contraste
  const factor = (259 * (opts.contrast * 255 + 255)) / (255 * (259 - opts.contrast * 255));
  for (let i = 0; i < data.length; i += 4) {
    const y = data[i];
    const c = factor * (y - 128) + 128;
    const cl = Math.max(0, Math.min(255, c));
    data[i] = data[i+1] = data[i+2] = cl;
  }
  // Umbral
  const thr = opts.threshold;
  for (let i = 0; i < data.length; i += 4) {
    const y = data[i];
    const v = y > thr ? 255 : 0;
    data[i] = data[i+1] = data[i+2] = v; data[i+3] = 255;
  }
  dctx.putImageData(imgData, 0, 0);
  return dstCanvas.toDataURL('image/png');
}

function sanitizeDocNumber(doc){
  return (doc||'').replace(/O/g,'0').replace(/B/g,'8').replace(/S/g,'5');
}

capBtn.onclick = ()=>{
  const ctx = canvasEl.getContext('2d');
  const w = canvasEl.width, h = canvasEl.height;
  ctx.drawImage(videoEl, 0, 0, w, h);
  const procDataUrl = preprocessImage(canvasEl, procCanvasEl, { contrast: 1.4, threshold: 150 });
  snapImg.src = procDataUrl;
  runOCR(procDataUrl);
};

// OCR & MRZ
const ocrRawEl = document.getElementById('ocrRaw');
const dniValEl = document.getElementById('dniValue');
const surValEl = document.getElementById('surnamesValue');
const nameValEl = document.getElementById('namesValue');
const dniStatusEl = document.getElementById('dniStatus');
const searchBtn = document.getElementById('searchListBtn');

function setAlert(level, title, message){
  const box = document.getElementById('alertBox');
  const ttl = document.getElementById('alertTitle');
  const txt = document.getElementById('alertText');
  box.classList.remove('alert--ok','alert--warn','alert--error');
  if(level === 'ok')      box.classList.add('alert--ok');
  else if(level === 'warn') box.classList.add('alert--warn');
  else                     box.classList.add('alert--error');
  ttl.textContent = title || 'Estado MRZ';
  txt.textContent = message || '';
  // Política: Cotejo solo cuando MRZ = OK
  searchBtn.disabled = (level !== 'ok');
  searchBtn.setAttribute('aria-disabled', searchBtn.disabled ? 'true' : 'false');
}

async function runOCR(dataUrl){
  ocrRawEl.textContent = 'Procesando OCR…';
  dniStatusEl.textContent = '';
  setAlert('warn','Procesando','Estamos leyendo la MRZ. Espera unos segundos.');

  const { data: { text } } = await Tesseract.recognize(
    dataUrl,
    'eng',
    { tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' }
  );

  ocrRawEl.textContent = text;
  const mrz = window.validateMRZfromOCR(text);

  if (!mrz.ok){
    mrzState = { status: 'error', checks: null };
    setAlert('error', 'MRZ inválida', 'No se pudo validar la banda MRZ. Recaptura enfocando las 3 líneas y dentro del marco.');
    dniStatusEl.textContent = '❌ MRZ no válida';
    dniStatusEl.style.color = '#dc3545';
    console.warn('[OCR] Texto reconocido (ruido):', text);
    return;
  }

  const f = mrz.fields;
  const cleanDoc = sanitizeDocNumber(f.docNumber);
  dniValEl.textContent  = cleanDoc;
  surValEl.textContent  = f.surnames;
  nameValEl.textContent = f.names;

  const c = mrz.checks;
  mrzState = { status: (c.allOk ? 'ok' : 'warn'), checks: c };

  if (c.allOk){
    setAlert('ok', 'MRZ verificada', 'Todos los dígitos de control coinciden. Puedes cotejar y validar el acceso.');
    dniStatusEl.textContent = '✅ MRZ válida';
    dniStatusEl.style.color = '#198754';
  } else {
    const msg = !c.compOk ? 'Fallo del dígito compuesto MRZ. Deriva a incidencias y verifica manualmente.'
                           : 'Algún dígito de control no coincide. Recaptura o deriva a incidencias.';
    setAlert('warn', 'Advertencia MRZ', msg);
    dniStatusEl.textContent = '⚠ MRZ con incongruencias';
    dniStatusEl.style.color = '#ffc107';
  }
}

// Listado y validación (CSV estático)
async function loadCSV(){
  const res = await fetch(CSV_URL);
  const txt = await res.text();
  attendees = csvToJSON(txt);
}
loadCSV().catch(err=> alert('Error cargando CSV: '+err.message));

document.getElementById('exportLogBtn').onclick = ()=>{
  downloadCSV('validados.csv', logs, ['Nombre','Apellido','DNI','Estado','Hora','Metodo']);
};
document.getElementById('exportIncBtn').onclick = ()=>{
  downloadCSV('incidencias.csv', incidents, ['Nombre','Apellido','DNI','Motivo','Hora']);
};

document.getElementById('searchListBtn').onclick = ()=>{
  const raw = dniValEl.textContent || '';
  const dni = normalizeDNI(raw);
  if (!dni) { alert('No hay DNI para buscar. Captura de nuevo.'); return; }
  console.log('[BUSCAR] DNI normalizado:', dni);
  const rows = attendees.filter(r=> normalizeDNI(r.DNI) === dni);
  if(!rows.length){
    addIncident({DNI:dni, Nombre:nameValEl.textContent, Apellido:surValEl.textContent}, 'DNI no encontrado en la convocatoria');
    alert('No está en la lista. Derivar a incidencias.');
    renderResults([], {mode:'auto'});
  } else {
    renderResults(rows, {mode:'auto'});
  }
};

function getLastMethodByDNI(dni){
  const nDni = normalizeDNI(dni);
  for(let i = logs.length - 1; i >= 0; i--){
    const entry = logs[i];
    if (normalizeDNI(entry.DNI) === nDni && entry.Estado === 'Validado'){
      return entry.Metodo || null;
    }
  }
  return null;
}

function renderResults(rows, options={mode:'auto'}){
  const mode = options.mode || 'auto';
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.className = r.Estado === 'Validado' ? 'row-valid' : (r.Estado === 'Incidencia' ? 'row-inc' : '');
    const lastMethod = getLastMethodByDNI(r.DNI);
    const badgeHtml =
      lastMethod === 'manual' ? '<span class="badge badge--manual">Manual</span>' :
      lastMethod === 'auto'   ? '<span class="badge badge--auto">Automático</span>' : '';
    tr.innerHTML = `
      <td>${r.Nombre||''}</td>
      <td>${r.Apellido||''}</td>
      <td>${r.DNI||''}</td>
      <td>${(r.Estado||'Pendiente')}${badgeHtml}</td>
      <td>
        <button class="btn-valid">Validar</button>
        <button class="btn-inc">Incidencia</button>
      </td>`;
    tr.querySelector('.btn-valid').onclick = ()=> validateAttendee(r, mode);
    tr.querySelector('.btn-inc').onclick   = ()=> addIncident(r, 'DNI no coincide / documento no legible');
    tbody.appendChild(tr);
  });
  setCounts();
}

function validateAttendee(r, mode='auto'){
  if (mode === 'manual' && mrzState && mrzState.status !== 'ok'){
    const msg = (mrzState.status === 'error')
      ? 'La MRZ es inválida. ¿Validar manualmente de todos modos?'
      : 'La MRZ presenta advertencias. ¿Validar manualmente de todos modos?';
    const proceed = confirm(msg);
    if(!proceed) return;
  }
  const now = new Date().toISOString();
  logs.push({ Nombre:r.Nombre, Apellido:r.Apellido, DNI:r.DNI, Estado:'Validado', Hora:now, Metodo:mode });
  setCounts();
  alert('Aspirante validado' + (mode==='manual' ? ' (validación manual).' : '.'));
}

function addIncident(r, reason){
  const now = new Date().toISOString();
  incidents.push({ Nombre:r.Nombre||'', Apellido:r.Apellido||'', DNI:r.DNI||'', Motivo:reason, Hora:now });
  setCounts();
}

// Búsqueda manual
function manualSearchByDNI(){
  const input = document.getElementById('manualDniInput').value || '';
  const dni = normalizeDNI(input);
  const rows = attendees.filter(r=> normalizeDNI(r.DNI) === dni);
  renderResults(rows, {mode:'manual'});
}

function manualSearchBySurname(){
  const s = (document.getElementById('manualSurnameInput').value || '').trim().toUpperCase();
  const results = attendees.filter(r=> (r.Apellido||'').toUpperCase().startsWith(s));
  renderResults(results, {mode:'manual'});
}
