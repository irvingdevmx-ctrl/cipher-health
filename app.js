/* ============================================================
   CipherHealth - Bootstrap de la app (Fase 1)
   - Navegacion entre vistas (Registrar / Historial / Estadisticas / Ajustes)
   - Init de la base de datos (IndexedDB con fallback a LocalStorage)
   - Indicador de almacenamiento en header y detalle en Ajustes
   - Stats rapidos en la vista de Estadisticas
   - Borrado total con confirmacion
   ============================================================ */

(function () {
  'use strict';

  // ---------- Constantes ----------
  const APP_VERSION = '0.6.0';
  const DEFAULT_VIEW = 'log';

  // Tipos de sintoma disponibles en el formulario (Fase 3).
  // El campo `value` se guarda en la base como `type` (string).
  const SYMPTOM_TYPES = [
    { value: 'Dolor de cabeza', icon: 'fa-head-side-virus' },
    { value: 'Dolor muscular',  icon: 'fa-person-running'  },
    { value: 'Fatiga',          icon: 'fa-bed'             },
    { value: 'Náusea',          icon: 'fa-face-dizzy'      },
    { value: 'Ansiedad',        icon: 'fa-heart-pulse'     },
    { value: 'Otro',            icon: 'fa-ellipsis'        },
  ];

  // Lookup rapido label -> icono (para historial y stats)
  const TYPE_ICON = SYMPTOM_TYPES.reduce((acc, t) => {
    acc[t.value] = t.icon;
    return acc;
  }, {});

  // ---------- Estado global ----------
  const state = {
    db: null,             // adaptador devuelto por CipherDB.init()
    currentView: null,
    form: {               // estado del formulario "Registrar"
      intensity: null,    // 1..10 o null
      type: null,         // string del SYMPTOM_TYPES o null
      notes: '',
      saving: false,
    },
    chart: null,          // instancia de Chart.js (Fase 4)
  };

  // ---------- Helpers DOM ----------
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[s]));
  }

  function showToast(msg, ms = 2400) {
    const host = $('#toast');
    host.innerHTML = `<div>${escapeHtml(msg)}</div>`;
    host.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => host.classList.remove('show'), ms);
  }

  // ---------- Navegacion entre vistas ----------
  function goto(view) {
    if (!view || view === state.currentView) {
      // Aun asi, asegurar que la vista exista visible
      if (view === state.currentView) return;
    }

    const sections = $$('.view');
    let found = false;
    sections.forEach(sec => {
      const match = sec.dataset.view === view;
      sec.classList.toggle('hidden', !match);
      if (match) found = true;
    });
    if (!found) return;

    state.currentView = view;

    // Sincronizar bottom nav (aria-current="page")
    $$('.nav-btn').forEach(btn => {
      if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    // Refrescos por vista
    if (view === 'history')  refreshHistory();
    if (view === 'stats')    refreshStats();
    if (view === 'settings') refreshSettingsDetail();

    // Scroll al tope al cambiar de vista
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function bindNavigation() {
    document.addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-action="goto"]');
      if (!target) return;
      goto(target.dataset.view);
    });
  }

  // ---------- Indicador de almacenamiento (header) ----------
  function updateStorageIndicator() {
    const icon = $('#storage-icon');
    const label = $('#storage-indicator');
    if (!state.db) {
      icon.className = 'fa-solid fa-circle-notch fa-spin';
      label.textContent = '…';
      return;
    }
    if (state.db.kind === 'indexeddb') {
      icon.className = 'fa-solid fa-lock text-brand';
      label.textContent = 'IndexedDB';
    } else {
      icon.className = 'fa-solid fa-triangle-exclamation text-warning';
      label.textContent = 'LocalStorage';
    }
  }

  function bindStorageButton() {
    $('#btn-storage-status').addEventListener('click', async () => {
      if (!state.db) return;
      try {
        const total = await state.db.countSymptoms();
        const label = state.db.kind === 'indexeddb'
          ? 'Guardado en IndexedDB (privado, en este dispositivo).'
          : 'IndexedDB no disponible. Usando LocalStorage como respaldo.';
        showToast(`${label} Registros: ${total}.`);
      } catch (err) {
        showToast('Error al consultar el almacenamiento.');
      }
    });
  }

  // ============================================================
  // Vista "Registrar" (Fase 3)
  // ============================================================

  /**
   * Devuelve un color HSL que va de verde (n=1) a rojo (n=10),
   * pasando por amarillo/naranja. Formato "R G B" listo para CSS var.
   */
  function intensityRGB(n) {
    // hue: 140 (verde) -> 0 (rojo)
    const t = (n - 1) / 9;
    const hue = 140 - 140 * t;
    const sat = 70;
    const lig = 48;
    // Conversion HSL -> RGB
    const c = (1 - Math.abs(2 * (lig / 100) - 1)) * (sat / 100);
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = (lig / 100) - c / 2;
    let r = 0, g = 0, b = 0;
    if      (hue <  60) { r = c; g = x; b = 0; }
    else if (hue < 120) { r = x; g = c; b = 0; }
    else if (hue < 180) { r = 0; g = c; b = x; }
    else if (hue < 240) { r = 0; g = x; b = c; }
    else if (hue < 300) { r = x; g = 0; b = c; }
    else                { r = c; g = 0; b = x; }
    const R = Math.round((r + m) * 255);
    const G = Math.round((g + m) * 255);
    const B = Math.round((b + m) * 255);
    return `${R} ${G} ${B}`;
  }

  function renderIntensityGrid() {
    const grid = $('#intensity-grid');
    if (!grid || grid.dataset.rendered === '1') return;
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= 10; n++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'intensity-btn';
      btn.dataset.intensity = String(n);
      btn.style.setProperty('--c', intensityRGB(n));
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute('aria-label', `Intensidad ${n} de 10`);
      btn.textContent = String(n);
      frag.appendChild(btn);
    }
    grid.appendChild(frag);
    grid.dataset.rendered = '1';

    grid.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.intensity-btn');
      if (!btn) return;
      const n = Number(btn.dataset.intensity);
      selectIntensity(n);
    });
  }

  function selectIntensity(n) {
    state.form.intensity = n;
    $$('#intensity-grid .intensity-btn').forEach(b => {
      b.setAttribute('aria-checked', Number(b.dataset.intensity) === n ? 'true' : 'false');
    });
    const help = $('#intensity-help');
    if (help) {
      const labels = ['', 'Muy leve', 'Leve', 'Leve', 'Moderado', 'Moderado',
                      'Notable', 'Fuerte', 'Fuerte', 'Severo', 'Insoportable'];
      help.textContent = `${n}/10 · ${labels[n]}`;
    }
    refreshSaveButton();
  }

  function renderTypeChips() {
    const host = $('#type-chips');
    if (!host || host.dataset.rendered === '1') return;
    const frag = document.createDocumentFragment();
    SYMPTOM_TYPES.forEach(t => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.type = t.value;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', 'false');
      chip.innerHTML = `<i class="fa-solid ${t.icon} text-muted" aria-hidden="true"></i><span>${escapeHtml(t.value)}</span>`;
      frag.appendChild(chip);
    });
    host.appendChild(frag);
    host.dataset.rendered = '1';

    host.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.chip');
      if (!chip) return;
      selectType(chip.dataset.type);
    });
  }

  function selectType(value) {
    state.form.type = value;
    $$('#type-chips .chip').forEach(c => {
      c.setAttribute('aria-checked', c.dataset.type === value ? 'true' : 'false');
    });
    const help = $('#type-help');
    if (help) help.textContent = value;
    refreshSaveButton();
  }

  function bindNotes() {
    const ta = $('#notes');
    const counter = $('#notes-counter');
    if (!ta) return;
    ta.addEventListener('input', () => {
      state.form.notes = ta.value;
      if (counter) counter.textContent = `${ta.value.length}/4000`;
    });
  }

  function refreshSaveButton() {
    const btn = $('#btn-save');
    if (!btn) return;
    if (state.form.saving) return; // no tocar en mitad del guardado
    const ready = state.form.intensity != null && !!state.form.type;
    btn.disabled = !ready;
    btn.setAttribute('aria-disabled', String(!ready));
  }

  function resetForm() {
    state.form.intensity = null;
    state.form.type = null;
    state.form.notes = '';
    $$('#intensity-grid .intensity-btn').forEach(b => b.setAttribute('aria-checked', 'false'));
    $$('#type-chips .chip').forEach(c => c.setAttribute('aria-checked', 'false'));
    const ta = $('#notes');
    if (ta) ta.value = '';
    const counter = $('#notes-counter');
    if (counter) counter.textContent = '0/4000';
    const help = $('#intensity-help');
    if (help) help.textContent = 'Toca un valor del 1 al 10';
    const tHelp = $('#type-help');
    if (tHelp) tHelp.textContent = 'Elige uno';
    refreshSaveButton();
  }

  function setSaveState(s) {
    const btn = $('#btn-save');
    if (!btn) return;
    if (s === 'idle') btn.removeAttribute('data-state');
    else btn.dataset.state = s; // 'saving' | 'done'
  }

  async function handleSave() {
    if (state.form.saving) return;
    const { intensity, type, notes } = state.form;
    if (intensity == null || !type) {
      showToast('Faltan datos: intensidad y tipo son obligatorios.');
      return;
    }
    if (!state.db) {
      showToast('Almacenamiento no listo. Intenta de nuevo en un momento.');
      return;
    }

    state.form.saving = true;
    const btn = $('#btn-save');
    btn.disabled = true;
    setSaveState('saving');

    try {
      // date/time NO se envian: db.js los asigna automaticamente (ahora).
      await state.db.saveSymptom({
        intensity,
        type,
        notes,
        tags: [],
      });

      setSaveState('done');
      showToast('Registro guardado.');
      // Pequena pausa para que se vea la confirmacion
      await new Promise(r => setTimeout(r, 700));
      resetForm();
      setSaveState('idle');
    } catch (err) {
      console.error('[CipherHealth] Error al guardar:', err);
      showToast(err.message || 'No se pudo guardar el registro.');
      setSaveState('idle');
      btn.disabled = false;
    } finally {
      state.form.saving = false;
      refreshSaveButton();
    }
  }

  function setupLogForm() {
    renderIntensityGrid();
    renderTypeChips();
    bindNotes();
    const btn = $('#btn-save');
    if (btn) btn.addEventListener('click', handleSave);
    refreshSaveButton();
  }

  // ---------- Vista Estadisticas ----------
  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  async function refreshStats() {
    if (!state.db) return;
    const today = new Date();
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6); // 7 dias incluyendo hoy

    try {
      const [total, weekList, todayList] = await Promise.all([
        state.db.countSymptoms(),
        state.db.getSymptomsByRange(isoDate(weekStart), isoDate(today)),
        state.db.getSymptomsByRange(isoDate(today),     isoDate(today)),
      ]);
      const set = (sel, v) => { const el = $(sel); if (el) el.textContent = String(v); };
      set('[data-stat="today"]', todayList.length);
      set('[data-stat="week"]',  weekList.length);
      set('[data-stat="total"]', total);

      // Promedio de intensidad de los ultimos 7 dias
      const avgEl = $('[data-stat="avg"]');
      if (weekList.length === 0) {
        if (avgEl) avgEl.textContent = '—';
      } else {
        const sum = weekList.reduce((s, r) => s + Number(r.intensity || 0), 0);
        const avg = sum / weekList.length;
        if (avgEl) avgEl.textContent = avg.toFixed(1);
      }

      // Sintoma mas frecuente en los ultimos 7 dias
      const topEl   = $('[data-stat="top"]');
      const topCnt  = $('[data-stat="top-count"]');
      if (weekList.length === 0) {
        if (topEl)  topEl.textContent  = '—';
        if (topCnt) topCnt.textContent = '—';
      } else {
        const counts = new Map();
        weekList.forEach(r => {
          const k = r.type || 'Otro';
          counts.set(k, (counts.get(k) || 0) + 1);
        });
        let bestKey = '—', bestVal = 0;
        counts.forEach((v, k) => { if (v > bestVal) { bestKey = k; bestVal = v; } });
        if (topEl)  topEl.textContent  = bestKey;
        if (topCnt) topCnt.textContent = `${bestVal} vez${bestVal === 1 ? '' : 'es'}`;
      }

      // Grafico
      renderIntensityChart(weekList, weekStart, today);
    } catch (err) {
      console.error('[CipherHealth] Error leyendo stats:', err);
      showToast('No se pudieron leer las estadísticas.');
    }
  }

  // ---- Chart.js: linea de intensidad de los ultimos 7 dias ----
  function renderIntensityChart(weekList, fromDate, toDate) {
    const canvas = $('#chart-intensity');
    const empty  = $('#chart-empty');
    if (!canvas || typeof Chart === 'undefined') return;

    // Construir 7 etiquetas (de fromDate a toDate inclusive) y agrupar por dia
    const labels = [];
    const isoLabels = [];
    const buckets = new Map();
    for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
      const iso = isoDate(d);
      isoLabels.push(iso);
      labels.push(d.toLocaleDateString('es', { weekday: 'short', day: 'numeric' }));
      buckets.set(iso, []);
    }
    weekList.forEach(r => {
      if (buckets.has(r.date)) buckets.get(r.date).push(Number(r.intensity || 0));
    });
    const data = isoLabels.map(iso => {
      const arr = buckets.get(iso);
      if (!arr || arr.length === 0) return null;
      return Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2));
    });

    const hasAnyData = data.some(v => v != null);
    if (empty) empty.classList.toggle('hidden', hasAnyData);
    canvas.parentElement.classList.toggle('opacity-40', !hasAnyData);

    // Color: verde -> rojo segun la media global de la serie.
    // Se usa rgba() con comas — formato universal que Chart.js parse sin problemas.
    const present = data.filter(v => v != null);
    const meanIntensity = present.length
      ? present.reduce((s, v) => s + v, 0) / present.length
      : 5;
    const rgb = intensityRGB(Math.max(1, Math.min(10, Math.round(meanIntensity)))).split(' ');
    const lineColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`;
    const fillColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.18)`;

    // Si ya hay un chart, destruirlo antes de crear uno nuevo
    if (state.chart) { state.chart.destroy(); state.chart = null; }

    try {
    state.chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Intensidad media',
          data,
          borderColor: lineColor,
          backgroundColor: fillColor,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: lineColor,
          pointBorderColor: 'rgba(255,255,255,0.85)',
          spanGaps: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(16,21,28,0.95)',
            borderColor: 'rgba(148,163,184,0.25)',
            borderWidth: 1,
            titleColor: '#e2e8f0',
            bodyColor: '#e2e8f0',
            displayColors: false,
            callbacks: {
              label: ctx => ctx.parsed.y == null ? 'Sin registros' : `Intensidad media: ${ctx.parsed.y}/10`,
            },
          },
        },
        scales: {
          y: {
            min: 0, max: 10,
            ticks: { stepSize: 2, color: 'rgba(148,163,184,0.85)', font: { size: 10 } },
            grid:  { color: 'rgba(148,163,184,0.12)' },
          },
          x: {
            ticks: { color: 'rgba(148,163,184,0.85)', font: { size: 10 } },
            grid:  { display: false },
          },
        },
      },
    });
    } catch (chartErr) {
      console.error('[CipherHealth] Error al renderizar el gráfico:', chartErr);
    }
  }

  // ============================================================
  // Vista "Historial" (Fase 4)
  // ============================================================

  function formatWhen(dateStr, timeStr) {
    // dateStr: YYYY-MM-DD, timeStr: HH:MM
    try {
      const [y, m, d] = dateStr.split('-').map(Number);
      const [hh, mm]  = (timeStr || '00:00').split(':').map(Number);
      const dt = new Date(y, m - 1, d, hh, mm);

      const today = new Date(); today.setHours(0,0,0,0);
      const target = new Date(y, m - 1, d);
      const diffDays = Math.round((today - target) / 86400000);

      const time = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
      if (diffDays === 0) return `Hoy · ${time}`;
      if (diffDays === 1) return `Ayer · ${time}`;
      if (diffDays > 1 && diffDays < 7) return `Hace ${diffDays} días · ${time}`;
      return `${dt.toLocaleDateString('es', { day: '2-digit', month: 'short' })} · ${time}`;
    } catch {
      return `${dateStr} ${timeStr || ''}`.trim();
    }
  }

  async function refreshHistory() {
    if (!state.db) return;
    const list = $('#history-list');
    const empty = $('#history-empty');
    const counter = $('#history-count');
    if (!list) return;

    try {
      const items = await state.db.getAllSymptoms();
      list.innerHTML = '';
      if (counter) counter.textContent = `${items.length} ${items.length === 1 ? 'registro' : 'registros'}`;

      if (items.length === 0) {
        if (empty) empty.classList.remove('hidden');
        return;
      }
      if (empty) empty.classList.add('hidden');

      const frag = document.createDocumentFragment();
      items.forEach(item => frag.appendChild(buildHistoryItem(item)));
      list.appendChild(frag);
    } catch (err) {
      console.error('[CipherHealth] Error leyendo historial:', err);
      list.innerHTML = '';
      if (counter) counter.textContent = '—';
      showToast('No se pudo cargar el historial.');
    }
  }

  function buildHistoryItem(item) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.id = String(item.id);
    li.style.setProperty('--c', intensityRGB(Math.max(1, Math.min(10, Number(item.intensity) || 1))));

    const icon = TYPE_ICON[item.type] || 'fa-circle-dot';
    const notesHtml = item.notes
      ? `<p class="h-notes">${escapeHtml(item.notes)}</p>`
      : '';

    li.innerHTML = `
      <div class="h-intensity" aria-label="Intensidad ${item.intensity} de 10">${item.intensity}</div>
      <div class="h-meta">
        <p class="h-type">
          <i class="fa-solid ${icon} text-muted" aria-hidden="true"></i>
          ${escapeHtml(item.type || 'Sin tipo')}
        </p>
        <p class="h-when">${escapeHtml(formatWhen(item.date, item.time))}</p>
        ${notesHtml}
      </div>
      <button class="h-delete" type="button" aria-label="Eliminar este registro" data-action="delete">
        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
      </button>
    `;

    li.querySelector('[data-action="delete"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = window.confirm('¿Eliminar este registro? No se puede deshacer.');
      if (!ok) return;
      try {
        await state.db.deleteSymptom(item.id);
        // Animacion de salida
        li.style.transition = 'opacity .15s ease, transform .15s ease';
        li.style.opacity = '0';
        li.style.transform = 'translateX(8px)';
        setTimeout(() => {
          li.remove();
          // Refrescar contador y estado vacio sin recargar todo
          const counter = $('#history-count');
          const list = $('#history-list');
          if (counter && list) {
            const n = list.children.length;
            counter.textContent = `${n} ${n === 1 ? 'registro' : 'registros'}`;
            if (n === 0) {
              const empty = $('#history-empty');
              if (empty) empty.classList.remove('hidden');
            }
          }
        }, 160);
        showToast('Registro eliminado.');
      } catch (err) {
        console.error('[CipherHealth] Error al eliminar:', err);
        showToast(err.message || 'No se pudo eliminar.');
      }
    });

    return li;
  }

  // ---------- Vista Ajustes: detalle de almacenamiento ----------
  async function refreshSettingsDetail() {
    const detail = $('#settings-storage-detail');
    if (!detail || !state.db) return;
    try {
      const total = await state.db.countSymptoms();
      const label = state.db.kind === 'indexeddb' ? 'IndexedDB (Dexie)' : 'LocalStorage (fallback)';
      detail.textContent = `${label} · ${total} registro(s).`;
    } catch {
      detail.textContent = 'No se pudo leer el almacenamiento.';
    }
  }

  // ============================================================
  // Exportación (Fase 5)
  // ============================================================

  /** Dispara la descarga de un blob en el navegador. Funciona en Chrome Android. */
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => {
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  /** Nombre de archivo con fecha local: cipher-health-2026-05-01 */
  function exportFilename(ext) {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `cipher-health-${yyyy}-${mm}-${dd}.${ext}`;
  }

  async function exportJSON() {
    const btn = $('#btn-export-json');
    if (!state.db || (btn && btn.disabled)) return;
    if (btn) btn.disabled = true;
    try {
      const items = await state.db.getAllSymptoms();
      if (items.length === 0) {
        showToast('No hay registros que exportar.');
        return;
      }
      const payload = {
        exportedAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        total: items.length,
        symptoms: items,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      triggerDownload(blob, exportFilename('json'));
      showToast(`${items.length} registro(s) exportados como JSON.`);
    } catch (err) {
      console.error('[CipherHealth] Error al exportar JSON:', err);
      showToast('No se pudo generar el archivo.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function exportCSV() {
    const btn = $('#btn-export-csv');
    if (!state.db || (btn && btn.disabled)) return;
    if (btn) btn.disabled = true;
    try {
      const items = await state.db.getAllSymptoms();
      if (items.length === 0) {
        showToast('No hay registros que exportar.');
        return;
      }

      // Cabecera en español para que el médico lo entienda de inmediato
      const HEADERS = ['Fecha', 'Hora', 'Intensidad (1-10)', 'Tipo de síntoma', 'Notas'];

      const escape = v => {
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return /[",\n\r]/.test(s) ? `"${s}"` : s;
      };

      const rows = [
        HEADERS.join(','),
        ...items.map(r => [
          r.date || '',
          r.time || '',
          r.intensity != null ? r.intensity : '',
          r.type || '',
          r.notes || '',
        ].map(escape).join(',')),
      ];

      // BOM para que Excel/Sheets abra correctamente con tildes
      const bom = '\uFEFF';
      const blob = new Blob([bom + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      triggerDownload(blob, exportFilename('csv'));
      showToast(`${items.length} registro(s) exportados como CSV.`);
    } catch (err) {
      console.error('[CipherHealth] Error al exportar CSV:', err);
      showToast('No se pudo generar el archivo.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function bindExports() {
    const btnJson = $('#btn-export-json');
    const btnCsv  = $('#btn-export-csv');
    if (btnJson) btnJson.addEventListener('click', exportJSON);
    if (btnCsv)  btnCsv.addEventListener('click',  exportCSV);
  }

  // ---------- Borrado total ----------
  function bindWipe() {
    const btn = $('#btn-wipe');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const ok = window.confirm('¿Borrar TODOS los datos locales? Esta acción no se puede deshacer.');
      if (!ok) return;
      try {
        await state.db.clearAll();
        showToast('Datos borrados correctamente.');
        refreshStats();
        refreshSettingsDetail();
      } catch (e) {
        console.error(e);
        showToast('Error al borrar los datos.');
      }
    });
  }

  // ============================================================
  // PWA: Service Worker + Install prompt (Fase 6)
  // ============================================================

  let _deferredInstallPrompt = null;

  function initPWA() {
    // ---- Registro del Service Worker ----
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(reg => {
          // Si hay una nueva version esperando, activarla al recargar
          reg.addEventListener('updatefound', () => {
            const newSW = reg.installing;
            if (!newSW) return;
            newSW.addEventListener('statechange', () => {
              if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
                showToast('Nueva versión disponible. Recarga para actualizar.');
              }
            });
          });
        })
        .catch(err => console.warn('[CipherHealth] SW no se pudo registrar:', err));
    }

    // ---- Prompt de instalación (Android Chrome) ----
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      _deferredInstallPrompt = ev;
      // Mostrar tarjeta de instalacion en Ajustes si ya está en esa vista
      const card = $('#pwa-install-card');
      if (card) card.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', () => {
      _deferredInstallPrompt = null;
      const card = $('#pwa-install-card');
      if (card) card.classList.add('hidden');
      showToast('CipherHealth instalada correctamente.');
    });

    // ---- Botón Instalar ----
    const btnInstall = $('#btn-pwa-install');
    if (btnInstall) {
      btnInstall.addEventListener('click', async () => {
        if (!_deferredInstallPrompt) {
          showToast('El navegador no permite la instalación manual en este momento.');
          return;
        }
        _deferredInstallPrompt.prompt();
        const { outcome } = await _deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          _deferredInstallPrompt = null;
        }
      });
    }
  }

  // Alias mantenido por compatibilidad (llamado desde boot)
  function registerServiceWorkerIfPresent() {
    initPWA();
  }

  // ---------- Bootstrap ----------
  async function boot() {
    // Mostrar version en header
    const v = $('#app-version');
    if (v) v.textContent = APP_VERSION;

    bindNavigation();
    bindStorageButton();
    bindWipe();
    bindExports();
    setupLogForm();

    try {
      state.db = await CipherDB.init();
      const first = await state.db.getSetting('firstOpenedAt', null);
      if (!first) await state.db.setSetting('firstOpenedAt', Date.now());
      await state.db.setSetting('lastOpenedAt', Date.now());
      await state.db.setSetting('appVersion', APP_VERSION);
    } catch (err) {
      console.error('[CipherHealth] No se pudo inicializar la base de datos:', err);
      showToast('Error al iniciar el almacenamiento local.');
    }

    updateStorageIndicator();
    goto(DEFAULT_VIEW);
    registerServiceWorkerIfPresent();
  }

  // Captura cualquier rechazo de Promise no manejado que escape de boot()
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    const msg = (reason instanceof Error) ? reason.message : String(reason ?? 'desconocido');
    console.error('[CipherHealth] Promesa sin capturar:', msg);
    ev.preventDefault(); // evita que el runtime marque el error como "no Error object"
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(e =>
      console.error('[CipherHealth] boot() fallo:', e)));
  } else {
    boot().catch(e => console.error('[CipherHealth] boot() fallo:', e));
  }
})();
