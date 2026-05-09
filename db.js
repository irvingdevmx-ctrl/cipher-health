/* ============================================================
   CipherHealth - Motor de base de datos (Fase 2)

   Base principal: IndexedDB via Dexie.js
   Fallback     : LocalStorage (cuando IndexedDB no esta disponible,
                  p.ej. modo incognito en algunos navegadores)

   Esquema actual (v2):
     symptoms : { id, date, time, intensity, type, notes, tags[] }
     settings : { key, value }

   API publica (window.CipherDB):
     init()                                -> Promise<adapter>
     adapter.saveSymptom(input)            -> Promise<id>
     adapter.getAllSymptoms()              -> Promise<Symptom[]>
     adapter.deleteSymptom(id)             -> Promise<void>
     adapter.getSymptomsByRange(startDate, endDate) -> Promise<Symptom[]>

   Helpers extra (usados por la UI):
     adapter.getSymptom(id), adapter.updateSymptom(id, patch),
     adapter.countSymptoms(),
     adapter.getSetting(key, fallback), adapter.setSetting(key, value),
     adapter.clearAll(),
     adapter.exportAll(), adapter.importAll(payload),
     adapter.kind  ('indexeddb' | 'localstorage')
   ============================================================ */

(function (global) {
  "use strict";

  // ---------- Constantes ----------
  const DB_NAME = "cipherhealth";
  const DB_VERSION = 2;
  const LS_PREFIX = "cipherhealth:";
  const LS_SYMPTOMS = LS_PREFIX + "symptoms";
  const LS_SETTINGS = LS_PREFIX + "settings";

  // ---------- Utilidades de validacion / normalizacion ----------

  /**
   * Normaliza y valida la entrada de un sintoma. Devuelve un objeto listo
   * para guardar o lanza un Error con mensaje claro.
   *
   * @param {object} input
   * @returns {{date:string,time:string,intensity:number,type:string,notes:string,tags:string[],createdAt:number,updatedAt:number}}
   */
  function normalizeSymptom(input) {
    if (!input || typeof input !== "object") {
      throw new Error("Sintoma invalido: se esperaba un objeto.");
    }

    const now = new Date();

    // date: YYYY-MM-DD (string ordenable y comparable lexicograficamente)
    let date = (input.date ?? "").toString().trim();
    if (!date) {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      date = `${y}-${m}-${d}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("date debe tener formato YYYY-MM-DD.");
    }

    // time: HH:MM (24h)
    let time = (input.time ?? "").toString().trim();
    if (!time) {
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      time = `${hh}:${mm}`;
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      throw new Error("time debe tener formato HH:MM.");
    }

    // intensity: entero 1..10
    const intensity = Number(input.intensity);
    if (!Number.isFinite(intensity) || intensity < 1 || intensity > 10) {
      throw new Error("intensity debe ser un numero entre 1 y 10.");
    }

    // type: string corto, requerido
    const type = (input.type ?? "").toString().trim();
    if (!type) throw new Error("type es obligatorio.");
    if (type.length > 80)
      throw new Error("type no puede exceder 80 caracteres.");

    // notes: opcional
    const notes = (input.notes ?? "").toString();
    if (notes.length > 4000)
      throw new Error("notes no puede exceder 4000 caracteres.");

    // tags: array de strings (deduplicado, sin vacios, lowercase)
    let tags = [];
    if (Array.isArray(input.tags)) {
      tags = Array.from(
        new Set(
          input.tags
            .map((t) => (t ?? "").toString().trim().toLowerCase())
            .filter(Boolean),
        ),
      );
    }

    const createdAt = Date.now();
    return {
      date,
      time,
      intensity: Math.round(intensity),
      type,
      notes,
      tags,
      createdAt,
      updatedAt: createdAt,
    };
  }

  function isValidDateStr(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  // ---------- Deteccion de IndexedDB ----------
  function indexedDbAvailable() {
    try {
      return typeof indexedDB !== "undefined" && !!indexedDB;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // Adaptador: IndexedDB via Dexie
  // ============================================================
  function createDexieAdapter() {
    if (typeof Dexie === "undefined") {
      throw new Error("Dexie no esta cargado.");
    }

    const db = new Dexie(DB_NAME);

    // v1 (Fase 1): se mantiene declarada para que Dexie sepa migrar
    db.version(1).stores({
      episodes: "++id, createdAt, intensity, *bodyParts, *triggers",
      meta: "&key",
    });

    // v2 (Fase 2): nuevo esquema. Las tablas viejas se descartan.
    db.version(2).stores({
      episodes: null,
      meta: null,
      symptoms: "++id, date, intensity, type, createdAt, *tags",
      settings: "&key",
    });

    return {
      kind: "indexeddb",

      // ---- API requerida por el spec ----
      async saveSymptom(input) {
        try {
          const row = normalizeSymptom(input);
          const id = await db.symptoms.add(row);
          return id;
        } catch (err) {
          console.error("[CipherDB] saveSymptom fallo:", err);
          throw new Error(`No se pudo guardar el sintoma: ${err.message}`);
        }
      },

      async getAllSymptoms() {
        try {
          // Mas recientes primero (por fecha y hora desc, fallback createdAt)
          const list = await db.symptoms.toArray();
          return list.sort((a, b) => {
            const ka = `${a.date} ${a.time}`;
            const kb = `${b.date} ${b.time}`;
            if (kb !== ka) return kb < ka ? -1 : 1;
            return (b.createdAt || 0) - (a.createdAt || 0);
          });
        } catch (err) {
          console.error("[CipherDB] getAllSymptoms fallo:", err);
          throw new Error(`No se pudo leer el historial: ${err.message}`);
        }
      },

      async deleteSymptom(id) {
        try {
          if (id == null) throw new Error("id requerido.");
          await db.symptoms.delete(id);
        } catch (err) {
          console.error("[CipherDB] deleteSymptom fallo:", err);
          throw new Error(`No se pudo eliminar el sintoma: ${err.message}`);
        }
      },

      async getSymptomsByRange(startDate, endDate) {
        try {
          if (!isValidDateStr(startDate) || !isValidDateStr(endDate)) {
            throw new Error(
              "startDate y endDate deben tener formato YYYY-MM-DD.",
            );
          }
          const [from, to] =
            startDate <= endDate ? [startDate, endDate] : [endDate, startDate];

          const list = await db.symptoms
            .where("date")
            .between(from, to, true, true)
            .toArray();

          return list.sort((a, b) => {
            const ka = `${a.date} ${a.time}`;
            const kb = `${b.date} ${b.time}`;
            return kb < ka ? -1 : kb > ka ? 1 : 0;
          });
        } catch (err) {
          console.error("[CipherDB] getSymptomsByRange fallo:", err);
          throw new Error(`No se pudo filtrar el historial: ${err.message}`);
        }
      },

      // ---- Helpers extra ----
      async getSymptom(id) {
        try {
          return (await db.symptoms.get(id)) || null;
        } catch (err) {
          console.error("[CipherDB] getSymptom fallo:", err);
          throw new Error(`No se pudo leer el sintoma: ${err.message}`);
        }
      },

      async updateSymptom(id, patch) {
        try {
          if (id == null) throw new Error("id requerido.");
          if (!patch || typeof patch !== "object")
            throw new Error("patch invalido.");
          const safe = Object.assign({}, patch, { updatedAt: Date.now() });
          return await db.symptoms.update(id, safe);
        } catch (err) {
          console.error("[CipherDB] updateSymptom fallo:", err);
          throw new Error(`No se pudo actualizar el sintoma: ${err.message}`);
        }
      },

      async countSymptoms() {
        try {
          return await db.symptoms.count();
        } catch (err) {
          console.error("[CipherDB] countSymptoms fallo:", err);
          return 0;
        }
      },

      async getSetting(key, fallback = null) {
        try {
          const row = await db.settings.get(key);
          return row ? row.value : fallback;
        } catch (err) {
          console.error("[CipherDB] getSetting fallo:", err);
          return fallback;
        }
      },

      async setSetting(key, value) {
        try {
          await db.settings.put({ key, value });
        } catch (err) {
          console.error("[CipherDB] setSetting fallo:", err);
          throw new Error(`No se pudo guardar el ajuste: ${err.message}`);
        }
      },

      async clearAll() {
        try {
          await db.transaction("rw", db.symptoms, db.settings, async () => {
            await db.symptoms.clear();
            await db.settings.clear();
          });
        } catch (err) {
          console.error("[CipherDB] clearAll fallo:", err);
          throw new Error(`No se pudo borrar la base: ${err.message}`);
        }
      },

      async exportAll() {
        try {
          const [symptoms, settings] = await Promise.all([
            db.symptoms.toArray(),
            db.settings.toArray(),
          ]);
          return {
            app: "cipherhealth",
            version: DB_VERSION,
            exportedAt: Date.now(),
            symptoms,
            settings,
          };
        } catch (err) {
          console.error("[CipherDB] exportAll fallo:", err);
          throw new Error(`No se pudo exportar: ${err.message}`);
        }
      },

      async importAll(payload) {
        try {
          if (!payload || !Array.isArray(payload.symptoms)) {
            throw new Error('Backup invalido: falta el arreglo "symptoms".');
          }
          await db.transaction("rw", db.symptoms, db.settings, async () => {
            await db.symptoms.clear();
            await db.settings.clear();
            if (payload.symptoms.length)
              await db.symptoms.bulkAdd(payload.symptoms);
            if (Array.isArray(payload.settings) && payload.settings.length) {
              await db.settings.bulkAdd(payload.settings);
            }
          });
        } catch (err) {
          console.error("[CipherDB] importAll fallo:", err);
          throw new Error(`No se pudo importar el backup: ${err.message}`);
        }
      },
    };
  }

  // ============================================================
  // Adaptador: LocalStorage (fallback)
  // ============================================================
  function createLocalStorageAdapter() {
    function readSymptoms() {
      try {
        const raw = localStorage.getItem(LS_SYMPTOMS);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    }
    function writeSymptoms(list) {
      localStorage.setItem(LS_SYMPTOMS, JSON.stringify(list));
    }
    function readSettings() {
      try {
        const raw = localStorage.getItem(LS_SETTINGS);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }
    function writeSettings(obj) {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(obj));
    }
    function nextId(list) {
      return list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
    }
    function sortByDateDesc(list) {
      return list.slice().sort((a, b) => {
        const ka = `${a.date} ${a.time}`;
        const kb = `${b.date} ${b.time}`;
        if (kb !== ka) return kb < ka ? -1 : 1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    }

    return {
      kind: "localstorage",

      async saveSymptom(input) {
        try {
          const row = normalizeSymptom(input);
          const list = readSymptoms();
          const id = nextId(list);
          list.push(Object.assign({ id }, row));
          writeSymptoms(list);
          return id;
        } catch (err) {
          console.error("[CipherDB:LS] saveSymptom fallo:", err);
          throw new Error(`No se pudo guardar el sintoma: ${err.message}`);
        }
      },

      async getAllSymptoms() {
        try {
          return sortByDateDesc(readSymptoms());
        } catch (err) {
          console.error("[CipherDB:LS] getAllSymptoms fallo:", err);
          throw new Error(`No se pudo leer el historial: ${err.message}`);
        }
      },

      async deleteSymptom(id) {
        try {
          if (id == null) throw new Error("id requerido.");
          const list = readSymptoms().filter((x) => x.id !== id);
          writeSymptoms(list);
        } catch (err) {
          console.error("[CipherDB:LS] deleteSymptom fallo:", err);
          throw new Error(`No se pudo eliminar el sintoma: ${err.message}`);
        }
      },

      async getSymptomsByRange(startDate, endDate) {
        try {
          if (!isValidDateStr(startDate) || !isValidDateStr(endDate)) {
            throw new Error(
              "startDate y endDate deben tener formato YYYY-MM-DD.",
            );
          }
          const [from, to] =
            startDate <= endDate ? [startDate, endDate] : [endDate, startDate];
          const list = readSymptoms().filter(
            (x) => x.date >= from && x.date <= to,
          );
          return sortByDateDesc(list);
        } catch (err) {
          console.error("[CipherDB:LS] getSymptomsByRange fallo:", err);
          throw new Error(`No se pudo filtrar el historial: ${err.message}`);
        }
      },

      // ---- Helpers extra ----
      async getSymptom(id) {
        try {
          return readSymptoms().find((x) => x.id === id) || null;
        } catch (err) {
          console.error("[CipherDB:LS] getSymptom fallo:", err);
          throw new Error(`No se pudo leer el sintoma: ${err.message}`);
        }
      },

      async updateSymptom(id, patch) {
        try {
          if (id == null) throw new Error("id requerido.");
          if (!patch || typeof patch !== "object")
            throw new Error("patch invalido.");
          const list = readSymptoms();
          const idx = list.findIndex((x) => x.id === id);
          if (idx < 0) return 0;
          list[idx] = Object.assign({}, list[idx], patch, {
            updatedAt: Date.now(),
          });
          writeSymptoms(list);
          return 1;
        } catch (err) {
          console.error("[CipherDB:LS] updateSymptom fallo:", err);
          throw new Error(`No se pudo actualizar el sintoma: ${err.message}`);
        }
      },

      async countSymptoms() {
        try {
          return readSymptoms().length;
        } catch (err) {
          console.error("[CipherDB:LS] countSymptoms fallo:", err);
          return 0;
        }
      },

      async getSetting(key, fallback = null) {
        try {
          const s = readSettings();
          return Object.prototype.hasOwnProperty.call(s, key)
            ? s[key]
            : fallback;
        } catch (err) {
          console.error("[CipherDB:LS] getSetting fallo:", err);
          return fallback;
        }
      },

      async setSetting(key, value) {
        try {
          const s = readSettings();
          s[key] = value;
          writeSettings(s);
        } catch (err) {
          console.error("[CipherDB:LS] setSetting fallo:", err);
          throw new Error(`No se pudo guardar el ajuste: ${err.message}`);
        }
      },

      async clearAll() {
        try {
          localStorage.removeItem(LS_SYMPTOMS);
          localStorage.removeItem(LS_SETTINGS);
        } catch (err) {
          console.error("[CipherDB:LS] clearAll fallo:", err);
          throw new Error(`No se pudo borrar la base: ${err.message}`);
        }
      },

      async exportAll() {
        try {
          const settings = readSettings();
          const settingsArr = Object.keys(settings).map((k) => ({
            key: k,
            value: settings[k],
          }));
          return {
            app: "cipherhealth",
            version: DB_VERSION,
            exportedAt: Date.now(),
            symptoms: readSymptoms(),
            settings: settingsArr,
          };
        } catch (err) {
          console.error("[CipherDB:LS] exportAll fallo:", err);
          throw new Error(`No se pudo exportar: ${err.message}`);
        }
      },

      async importAll(payload) {
        try {
          if (!payload || !Array.isArray(payload.symptoms)) {
            throw new Error('Backup invalido: falta el arreglo "symptoms".');
          }
          writeSymptoms(payload.symptoms);
          const obj = {};
          if (Array.isArray(payload.settings)) {
            payload.settings.forEach((s) => {
              if (s && s.key) obj[s.key] = s.value;
            });
          }
          writeSettings(obj);
        } catch (err) {
          console.error("[CipherDB:LS] importAll fallo:", err);
          throw new Error(`No se pudo importar el backup: ${err.message}`);
        }
      },
    };
  }

  // ============================================================
  // Init: elige el mejor adaptador disponible
  // ============================================================
  async function init() {
    if (indexedDbAvailable() && typeof Dexie !== "undefined") {
      try {
        const adapter = createDexieAdapter();
        // Probar una operacion ligera para confirmar que abre.
        await adapter.countSymptoms();
        return adapter;
      } catch (err) {
        console.warn(
          "[CipherHealth] IndexedDB fallo, usando LocalStorage. Causa:",
          err,
        );
      }
    }
    return createLocalStorageAdapter();
  }

  global.CipherDB = { init };
})(window);
