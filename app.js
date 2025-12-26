/* ===========================
   Configuración y estado
   =========================== */
const CSV_URL = 'data/convocatoria.csv';
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
let attendees = [];
let logs = JSON.parse(localStorage.getItem('logs') || '[]');
let incidents = JSON.parse(localStorage.getItem('incidents') || '[]');
let stream = null;
let mrzState = { status: 'init', checks: null }; // 'ok' | 'warn' | 'error' | 'init'

/* ===========================
   Utilidades generales
   =========================== */
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
function normalizeDNI(s){ return (s||'').toUpperCase().replace(/\s+/g,'').replace(/-/g,''); }
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

/* ===========================
   Cámara (getUserMedia)
   =========================== */
const videoEl = document.getElementById('video');
const canvasEl = document.getElementById('canvas');
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

capBtn.onclick = ()=>{
  const ctx = canvasEl.getContext('2d');
  const w = canvasEl.width, h = canvasEl.height;
  ctx.drawImage(videoEl, 0, 0, w, h);
  const dataUrl = canvasEl.toDataURL('image/png');
  snapImg.src = dataUrl;
  runOCR(dataUrl);
};

/* ===========================
   OCR y MRZ
   =========================== */
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
  // Política: Cotejo sólo cuando MRZ = OK
  searchBtn.disabled = (level !== 'ok');
  searchBtn.setAttribute('aria-disabled', searchBtn.disabled ? 'true' : 'false');
}

async function runOCR(dataUrl){
  ocrRawEl.textContent = 'Procesando OCR…';
  dniStatusEl.textContent = '';
  setAlert('warn','Procesando','Estamos leyendo la MRZ. Espera unos segundos.');

  const { data: { text } } = await Tesseract.recognize(dataUrl, 'eng', { logger:m=>console.log(m) });
  ocrRawEl.textContent = text;

  const mrz = window.validateMRZfromOCR(text);

  if (!mrz.ok){
    mrzState = { status: 'error', checks: null };
    setAlert('error', 'MRZ inválida', 'No se pudo validar la banda MRZ. Recaptura enfocando las 3 líneas o deriva a incidencias.');
    dniStatusEl.textContent = '❌ MRZ no válida';
    dniStatusEl.style.color = '#dc3545';
    return;
  }

  const f = mrz.fields;
  dniValEl.textContent  = f.docNumber;
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

/* ===========================
   Listado y validación
   =========================== */
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
  const dni = dniValEl.textContent;
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

/* ===========================
   Búsqueda manual
   =========================== */
function manualSearchByDNI(){
  const input = document.getElementById('manualDniInput').value || '';
  const dni = normalizeDNI(input);
  const hintEl = document.getElementById('manualDniHint');
  if (!isValidDNISpain(dni)){
    hintEl.textContent = 'Formato/letra de DNI no válida. Puedes corregir o continuar.';
    hintEl.style.color = '#dc3545';
  } else {
    hintEl.textContent = 'DNI válido.';
    hintEl.style.color = '#198754';
  }
  const rows = attendees.filter(r=> normalizeDNI(r.DNI) === dni);
  renderResults(rows, {mode:'manual'});
  if(!rows.length){
    addIncident({DNI:dni}, 'DNI no encontrado en convocatoria (búsqueda manual)');
    alert('No está en la lista. Derivar a incidencias si procede.');
  }
}

function manualSearchBySurname(){
  const s = (document.getElementById('manualSurnameInput').value || '').trim().toUpperCase();
  const results = attendees.filter(r=> (r.Apellido||'').toUpperCase().startsWith(s));
  renderResults(results, {mode:'manual'});
  if(!results.length){ alert('Sin coincidencias por apellido.'); }
}

document.getElementById('manualDniBtn').onclick = manualSearchByDNI;
document.getElementById('manualSurnameBtn').onclick = manualSearchBySurname;
