const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database('sisr.db');
db.pragma('foreign_keys = ON');

/* =====================================================================
   TABLAS
   ===================================================================== */

const existiaLineas = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lineas_estrategicas'").get();
const existiaProgramas = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='programas'").get();
const existiaProductos = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='productos'").get();
const existiaLogos = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='logos'").get();

db.exec(`
  CREATE TABLE IF NOT EXISTS lineas_estrategicas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_linea_estrategica INTEGER NOT NULL UNIQUE,
    nombre_linea TEXT NOT NULL
  )`);

db.exec(`
  CREATE TABLE IF NOT EXISTS administradores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    cargo TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    telefono TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'Administrador'
      CHECK (rol IN ('Administrador','Superadministrador')),
    estado TEXT NOT NULL DEFAULT 'Activo'
      CHECK (estado IN ('Activo','Inactivo','Bloqueado')),
    ultimo_acceso TEXT,
    ip_ultimo_acceso TEXT,
    intentos_fallidos INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

db.exec(`
  CREATE TABLE IF NOT EXISTS gestores (
    id_gestor INTEGER PRIMARY KEY AUTOINCREMENT,
    administrador_id INTEGER NOT NULL
      REFERENCES administradores(id) ON DELETE RESTRICT,
    nombre TEXT NOT NULL,
    cargo TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    telefono TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'Gestor'
      CHECK (rol IN ('Gestor','Gestor líder')),
    estado TEXT NOT NULL DEFAULT 'Activo'
      CHECK (estado IN ('Activo','Inactivo','Bloqueado')),
    ultimo_acceso TEXT,
    ip_ultimo_acceso TEXT,
    intentos_fallidos INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

db.exec('CREATE INDEX IF NOT EXISTS idx_gestores_admin ON gestores(administrador_id)');

db.exec(`
  CREATE TABLE IF NOT EXISTS programas (
    codigo_programa TEXT PRIMARY KEY,
    linea_id INTEGER NOT NULL
      REFERENCES lineas_estrategicas(id) ON DELETE RESTRICT,
    nombre_programa TEXT NOT NULL,
    sector TEXT NOT NULL DEFAULT '',
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

db.exec('CREATE INDEX IF NOT EXISTS idx_programas_linea ON programas(linea_id)');

db.exec(`
  CREATE TABLE IF NOT EXISTS productos (
    codigo_producto TEXT PRIMARY KEY,
    codigo_programa TEXT NOT NULL
      REFERENCES programas(codigo_programa) ON DELETE RESTRICT,
    nombre_producto TEXT NOT NULL,
    codigo_indicador_producto TEXT NOT NULL UNIQUE,
    indicador_producto TEXT NOT NULL,
    meta_redactada TEXT NOT NULL DEFAULT '',
    linea_base REAL NOT NULL DEFAULT 0 CHECK (linea_base >= 0),
    meta_cuatrienio REAL NOT NULL DEFAULT 0 CHECK (meta_cuatrienio >= 0),
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

db.exec('CREATE INDEX IF NOT EXISTS idx_productos_programa ON productos(codigo_programa)');

// Marca institucional: el logo se guarda dentro de la propia base de datos (columna BLOB)
db.exec(`
  CREATE TABLE IF NOT EXISTS logos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_entidad TEXT NOT NULL,
    logo BLOB,
    logo_tipo TEXT,
    logo_nombre TEXT,
    logo_actualizado TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
      (logo IS NULL AND logo_tipo IS NULL) OR
      (logo IS NOT NULL AND logo_tipo IN ('image/png','image/jpeg','image/webp','image/gif'))
    )
  )`);

// Asignaciones: cada meta (producto) tiene como máximo un gestor responsable
db.exec(`
  CREATE TABLE IF NOT EXISTS asignaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo_producto TEXT NOT NULL UNIQUE
      REFERENCES productos(codigo_producto) ON DELETE RESTRICT,
    gestor_id INTEGER NOT NULL
      REFERENCES gestores(id_gestor) ON DELETE RESTRICT,
    administrador_id INTEGER NOT NULL
      REFERENCES administradores(id) ON DELETE RESTRICT,
    dependencia TEXT NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

db.exec('CREATE INDEX IF NOT EXISTS idx_asignaciones_gestor ON asignaciones(gestor_id)');

db.exec(`
  CREATE TABLE IF NOT EXISTS ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  )`);

// Cumplimientos: avance que un gestor reporta sobre una meta que tiene asignada.
// En un borrador solo se exige el indicador; lo demás se valida al enviar a revisión.
db.exec(`
  CREATE TABLE IF NOT EXISTS cumplimientos (
    id_cumplimiento INTEGER PRIMARY KEY AUTOINCREMENT,
    gestor_id INTEGER NOT NULL
      REFERENCES gestores(id_gestor) ON DELETE RESTRICT,
    codigo_producto TEXT NOT NULL
      REFERENCES productos(codigo_producto) ON DELETE RESTRICT,
    periodo TEXT CHECK (periodo IS NULL OR periodo IN ('Mensual','Trimestral')),
    avance_reportado REAL CHECK (avance_reportado IS NULL OR avance_reportado >= 0),
    porcentaje_cumplimiento REAL
      CHECK (porcentaje_cumplimiento IS NULL OR (porcentaje_cumplimiento >= 0 AND porcentaje_cumplimiento <= 100)),
    estado_revision TEXT NOT NULL DEFAULT 'Borrador'
      CHECK (estado_revision IN ('Borrador','Pendiente','Aprobado','Devuelto')),
    fecha_registro TEXT NOT NULL DEFAULT (date('now','localtime')),
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

db.exec('CREATE INDEX IF NOT EXISTS idx_cumplimientos_gestor ON cumplimientos(gestor_id)');

// Revisión: observación del administrador y quién/cuándo revisó (se agregan si la tabla ya existía)
for (const [col, tipo] of [['observacion_revision', 'TEXT'], ['revisado_por', 'INTEGER REFERENCES administradores(id)'], ['fecha_revision', 'TEXT']])
  if (!db.prepare('PRAGMA table_info(cumplimientos)').all().some(c => c.name === col))
    db.exec('ALTER TABLE cumplimientos ADD COLUMN ' + col + ' ' + tipo);

// Interpretación del avance: logro alcanzado y población beneficiada (ambos texto; la población admite letras y números)
for (const [col, tipo] of [['logro_alcanzado', 'TEXT'], ['poblacion_beneficiada', 'TEXT']])
  if (!db.prepare('PRAGMA table_info(cumplimientos)').all().some(c => c.name === col))
    db.exec('ALTER TABLE cumplimientos ADD COLUMN ' + col + ' ' + tipo);

// Evidencias: varios archivos por cumplimiento, guardados como BLOB igual que los logos
db.exec(`
  CREATE TABLE IF NOT EXISTS evidencias (
    id_evidencia INTEGER PRIMARY KEY AUTOINCREMENT,
    id_cumplimiento INTEGER NOT NULL
      REFERENCES cumplimientos(id_cumplimiento) ON DELETE CASCADE,
    nombre_archivo TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('image/jpeg','image/png','application/pdf')),
    archivo BLOB NOT NULL,
    tamano INTEGER NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

db.exec('CREATE INDEX IF NOT EXISTS idx_evidencias_cumplimiento ON evidencias(id_cumplimiento)');

// Líneas estratégicas: datos iniciales, solo cuando la tabla se crea por primera vez
if (!existiaLineas) {
  const ins = db.prepare('INSERT INTO lineas_estrategicas (id, numero_linea_estrategica, nombre_linea) VALUES (?,?,?)');
  [[300, 1, 'Compromiso por Usiacurí en el desarrollo social'],
   [301, 2, 'Compromiso por Usiacurí en desarrollo territorial'],
   [302, 3, 'Compromiso por Usiacurí en ambiental y desarrollo sostenible'],
   [303, 4, 'Compromiso por Usiacurí para el fortalecimiento institucional']
  ].forEach(r => ins.run(...r));
}

// Programas: datos iniciales, solo cuando la tabla se crea por primera vez
// (se omiten los que apunten a una línea que ya no exista)
if (!existiaProgramas) {
  const existeLinea = db.prepare('SELECT 1 FROM lineas_estrategicas WHERE id=?');
  const insP = db.prepare('INSERT INTO programas (codigo_programa, linea_id, nombre_programa, sector) VALUES (?,?,?,?)');
  const semilla = [
    ['1903', 300, 'Inspección, vigilancia y control', 'Salud'],
    ['1905', 300, 'Salud pública', 'Salud'],
    ['2102', 301, 'Consolidación productiva del sector de energía eléctrica', 'Infraestructura'],
    ['2401', 301, 'Infraestructura red vial primaria', 'Infraestructura'],
    ['1702', 302, 'Inclusión productiva de pequeños productores rurales', 'Agropecuario'],
    ['1703', 302, 'Servicios financieros y gestión del riesgo para las actividades agropecuarias y rurales', 'Agropecuario'],
    ['1709', 302, 'Infraestructura productiva y comercialización', 'Agropecuario'],
    ['406', 303, 'Generación de la información geográfica del territorio nacional', 'Información estadística'],
    ['1202', 303, 'Promoción al acceso a la justicia', 'Justicia y del derecho']
  ];
  db.transaction(() => {
    semilla.forEach(p => { if (existeLinea.get(p[1])) insP.run(...p); });
  })();
}

// Productos: datos iniciales, solo cuando la tabla se crea por primera vez
// (se omiten los que apunten a un programa que ya no exista)
if (!existiaProductos) {
  const existePrograma = db.prepare('SELECT 1 FROM programas WHERE codigo_programa=?');
  const insProd = db.prepare(`
    INSERT INTO productos (codigo_producto, codigo_programa, nombre_producto, codigo_indicador_producto,
                           indicador_producto, meta_redactada, linea_base, meta_cuatrienio)
    VALUES (?,?,?,?,?,?,?,?)`);
  const semillaProductos = [
    ['1903031', '1903', 'Servicio de información de vigilancia epidemiológica', '190303100', 'Informes de evento generados en la vigilancia', 'Elaboración de informes de inspección, vigilancia y control de los servicios de salud pública del municipio de Usiacurí.', 2, 4],
    ['1905004', '1905', 'Cementerios remodelados', '190500400', 'Cementerios remodelados', 'Adecuar el cementerio municipal.', 0, 2],
    ['2102013', '2102', 'Redes de alumbrado público mejoradas', '210201300', 'Metros de redes de alumbrado público', 'Redes de alumbrado público mejoradas', 200, 500],
    ['2401012', '2401', 'Vía pavimentada', '240211300', 'Vía urbana construida', 'Construcción de ml de vías urbanas', 200, 500],
    ['1702007', '1702', 'Servicio de apoyo financiero para proyectos productivos', '170200701', 'Pequeños productores apoyados', 'Proyectos productivos para campesinos.', 2, 4],
    ['1703006', '1703', 'Servicio de apoyo financiero para el acceso al crédito agropecuario y rural', '170300600', 'Productores con acceso a crédito agropecuario y rural', 'Articular con las entidades bancarias jornada de crédito para campesinos.', 2, 2],
    ['1709114', '1709', 'Servicio de dotación de maquinaria y equipos para la producción agropecuaria', '170911405', 'Productores beneficiados con maquinaria y equipo', 'Beneficiar a pequeños productores con maquinaria y equipo.', 2, 600],
    ['406016', '406', 'Servicio de actualización catastral con enfoque multipropósito', '40601600', 'Área geográfica actualizada catastralmente con enfoque multipropósito', 'Realizar la actualización catastral.', 0, 1],
    ['1202002', '1202', 'Servicio de justicia a los ciudadanos', '120200200', 'Ciudadanos con servicio de justicia prestado', 'Desarrollar entornos seguros.', 0, 4]
  ];
  db.transaction(() => {
    semillaProductos.forEach(p => { if (existePrograma.get(p[1])) insProd.run(...p); });
  })();
}

// Logos: entidades iniciales (sin imagen), solo cuando la tabla se crea por primera vez
if (!existiaLogos) {
  const insLogo = db.prepare('INSERT INTO logos (nombre_entidad) VALUES (?)');
  ['Alcaldía de Usiacurí', 'Secretaría de Medio Ambiente'].forEach(n => insLogo.run(n));
}

// Administradores: el primer id asignado será 100
if (!db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'administradores'").get()) {
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('administradores', 99)").run();
}

/* =====================================================================
   APP
   ===================================================================== */

const app = express();
app.use(express.json());
// Al entrar por la dirección raíz (http://servidor:3000) se lleva al inicio de sesión
app.get('/', (req, res) => res.redirect('/iniciar-sesion.html'));
app.use(express.static('public'));

/* ---------- Líneas estratégicas ---------- */

const SELECT_LINEA = 'SELECT id, numero_linea_estrategica AS numero, nombre_linea AS nombre FROM lineas_estrategicas';

app.get('/api/lineas', (req, res) =>
  res.json(db.prepare(SELECT_LINEA + ' ORDER BY numero_linea_estrategica').all()));

app.post('/api/lineas', (req, res) => {
  const { numero, nombre } = req.body;
  if (!numero || !nombre?.trim()) return res.status(400).json({ error: 'Datos incompletos' });
  try {
    const r = db.prepare('INSERT INTO lineas_estrategicas (numero_linea_estrategica, nombre_linea) VALUES (?,?)').run(numero, nombre.trim());
    res.status(201).json(db.prepare(SELECT_LINEA + ' WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(409).json({ error: 'Ese número de línea ya existe' }); }
});

app.put('/api/lineas/:id', (req, res) => {
  const { numero, nombre } = req.body;
  try {
    db.prepare('UPDATE lineas_estrategicas SET numero_linea_estrategica=?, nombre_linea=? WHERE id=?').run(numero, nombre.trim(), req.params.id);
    res.json(db.prepare(SELECT_LINEA + ' WHERE id=?').get(req.params.id));
  } catch (e) { res.status(409).json({ error: 'Ese número de línea ya existe' }); }
});

app.delete('/api/lineas/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM lineas_estrategicas WHERE id=?').run(req.params.id);
    res.status(204).end();
  } catch (e) {
    if (esErrorForaneo(e))
      return res.status(409).json({ error: 'Esta línea tiene programas asignados. Reasígnalos o elimínalos primero' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ---------- Programas (pertenecen a una línea estratégica) ---------- */

const CODIGO_RE = /^[A-Za-z0-9._-]{1,20}$/;

const SELECT_PROGRAMA = `
  SELECT codigo_programa AS codigo, linea_id AS lineaId, nombre_programa AS nombre, sector
  FROM programas`;

function validarPrograma(b) {
  const codigo = String(b.codigo ?? '').trim();
  const lineaId = Number(b.lineaId);
  const nombre = String(b.nombre ?? '').trim();
  const sector = String(b.sector ?? '').trim();

  if (!CODIGO_RE.test(codigo)) return { error: 'El codigo_programa debe tener de 1 a 20 caracteres (letras, números, punto o guion)' };
  if (!Number.isInteger(lineaId) || !db.prepare('SELECT 1 FROM lineas_estrategicas WHERE id=?').get(lineaId))
    return { error: 'La línea estratégica seleccionada no existe' };
  if (!nombre) return { error: 'El nombre del programa es obligatorio' };

  return { datos: { codigo, lineaId, nombre, sector } };
}

app.get('/api/programas', (req, res) =>
  res.json(db.prepare(SELECT_PROGRAMA + ' ORDER BY CAST(codigo_programa AS INTEGER), codigo_programa').all()));

app.post('/api/programas', (req, res) => {
  const v = validarPrograma(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  try {
    db.prepare('INSERT INTO programas (codigo_programa, linea_id, nombre_programa, sector) VALUES (?,?,?,?)')
      .run(d.codigo, d.lineaId, d.nombre, d.sector);
    res.status(201).json(db.prepare(SELECT_PROGRAMA + ' WHERE codigo_programa=?').get(d.codigo));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'Ese codigo_programa ya existe' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// El codigo_programa es la llave primaria: no se modifica, solo se identifica con él
app.put('/api/programas/:codigo', (req, res) => {
  const codigo = req.params.codigo;
  if (!db.prepare('SELECT 1 FROM programas WHERE codigo_programa=?').get(codigo))
    return res.status(404).json({ error: 'Programa no encontrado' });

  const v = validarPrograma({ ...req.body, codigo });
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;

  db.prepare('UPDATE programas SET linea_id=?, nombre_programa=?, sector=? WHERE codigo_programa=?')
    .run(d.lineaId, d.nombre, d.sector, codigo);
  res.json(db.prepare(SELECT_PROGRAMA + ' WHERE codigo_programa=?').get(codigo));
});

app.delete('/api/programas/:codigo', (req, res) => {
  try {
    db.prepare('DELETE FROM programas WHERE codigo_programa=?').run(req.params.codigo);
    res.status(204).end();
  } catch (e) {
    if (esErrorForaneo(e))
      return res.status(409).json({ error: 'Este programa tiene productos asignados. Reasígnalos o elimínalos primero' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ---------- Productos, indicadores y metas (pertenecen a un programa) ---------- */

const SELECT_PRODUCTO = `
  SELECT codigo_producto AS codprod, codigo_programa AS progCodigo, nombre_producto AS nomprod,
         codigo_indicador_producto AS codind, indicador_producto AS indprod,
         meta_redactada AS metared, linea_base AS lineabase, meta_cuatrienio AS metacuatrienio
  FROM productos`;

function numeroNoNegativo(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function validarProducto(b) {
  const codprod = String(b.codprod ?? '').trim();
  const progCodigo = String(b.progCodigo ?? '').trim();
  const nomprod = String(b.nomprod ?? '').trim();
  const codind = String(b.codind ?? '').trim();
  const indprod = String(b.indprod ?? '').trim();
  const metared = String(b.metared ?? '').trim();
  const lineabase = numeroNoNegativo(b.lineabase);
  const metacuatrienio = numeroNoNegativo(b.metacuatrienio);

  if (!CODIGO_RE.test(codprod)) return { error: 'El codigo_producto debe tener de 1 a 20 caracteres (letras, números, punto o guion)' };
  if (!db.prepare('SELECT 1 FROM programas WHERE codigo_programa=?').get(progCodigo))
    return { error: 'El programa seleccionado no existe' };
  if (!nomprod) return { error: 'El nombre del producto es obligatorio' };
  if (!CODIGO_RE.test(codind)) return { error: 'El codigo_indicador_producto debe tener de 1 a 20 caracteres (letras, números, punto o guion)' };
  if (!indprod) return { error: 'El indicador del producto es obligatorio' };
  if (Number.isNaN(lineabase) || Number.isNaN(metacuatrienio))
    return { error: 'La línea base y la meta del cuatrienio deben ser números mayores o iguales a 0' };

  return { datos: { codprod, progCodigo, nomprod, codind, indprod, metared, lineabase, metacuatrienio } };
}

function responderErrorProducto(e, res) {
  if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const campo = String(e.message).includes('codigo_indicador_producto') ? 'codigo_indicador_producto' : 'codigo_producto';
    return res.status(409).json({ error: 'Ese ' + campo + ' ya existe' });
  }
  console.error(e);
  res.status(500).json({ error: 'Error del servidor' });
}

app.get('/api/productos', (req, res) =>
  res.json(db.prepare(SELECT_PRODUCTO + ' ORDER BY CAST(codigo_producto AS INTEGER), codigo_producto').all()));

app.post('/api/productos', (req, res) => {
  const v = validarProducto(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  try {
    db.prepare(`
      INSERT INTO productos (codigo_producto, codigo_programa, nombre_producto, codigo_indicador_producto,
                             indicador_producto, meta_redactada, linea_base, meta_cuatrienio)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(d.codprod, d.progCodigo, d.nomprod, d.codind, d.indprod, d.metared, d.lineabase, d.metacuatrienio);
    res.status(201).json(db.prepare(SELECT_PRODUCTO + ' WHERE codigo_producto=?').get(d.codprod));
  } catch (e) { responderErrorProducto(e, res); }
});

// El codigo_producto es la llave primaria: no se modifica, solo se identifica con él
app.put('/api/productos/:codigo', (req, res) => {
  const codigo = req.params.codigo;
  if (!db.prepare('SELECT 1 FROM productos WHERE codigo_producto=?').get(codigo))
    return res.status(404).json({ error: 'Producto no encontrado' });

  const v = validarProducto({ ...req.body, codprod: codigo });
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  try {
    db.prepare(`
      UPDATE productos
      SET codigo_programa=?, nombre_producto=?, codigo_indicador_producto=?, indicador_producto=?,
          meta_redactada=?, linea_base=?, meta_cuatrienio=?
      WHERE codigo_producto=?`)
      .run(d.progCodigo, d.nomprod, d.codind, d.indprod, d.metared, d.lineabase, d.metacuatrienio, codigo);
    res.json(db.prepare(SELECT_PRODUCTO + ' WHERE codigo_producto=?').get(codigo));
  } catch (e) { responderErrorProducto(e, res); }
});

app.delete('/api/productos/:codigo', (req, res) => {
  try {
    db.prepare('DELETE FROM productos WHERE codigo_producto=?').run(req.params.codigo);
    res.status(204).end();
  } catch (e) {
    if (esErrorForaneo(e))
      return res.status(409).json({ error: 'Este producto está asignado a un gestor. Quita la asignación primero' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ---------- Marca institucional (entidades y logos) ---------- */

const MAX_LOGO = '2mb';

// Nunca se devuelve el contenido de la imagen en el listado, solo sus datos
const SELECT_LOGO = `
  SELECT id, nombre_entidad AS nombre, (logo IS NOT NULL) AS tieneLogo,
         logo_nombre AS logoNombre, logo_tipo AS logoTipo,
         COALESCE(length(logo), 0) AS logoBytes, COALESCE(logo_actualizado, '') AS version
  FROM logos`;

const filaLogo = r => r && { ...r, tieneLogo: !!r.tieneLogo };

// El tipo se deduce de los primeros bytes del archivo, no del nombre ni de lo que declare el navegador
function tipoImagen(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function nombreArchivoSeguro(cabecera) {
  let n = String(cabecera || '');
  try { n = decodeURIComponent(n); } catch (e) { /* se deja tal cual */ }
  n = n.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return n || 'logo';
}

app.get('/api/logos', (req, res) =>
  res.json(db.prepare(SELECT_LOGO + ' ORDER BY id').all().map(filaLogo)));

app.post('/api/logos', (req, res) => {
  const nombre = String(req.body.nombre ?? '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre de la entidad es obligatorio' });
  const r = db.prepare('INSERT INTO logos (nombre_entidad) VALUES (?)').run(nombre);
  res.status(201).json(filaLogo(db.prepare(SELECT_LOGO + ' WHERE id=?').get(r.lastInsertRowid)));
});

app.put('/api/logos/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM logos WHERE id=?').get(id))
    return res.status(404).json({ error: 'Entidad no encontrada' });
  const nombre = String(req.body.nombre ?? '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre de la entidad es obligatorio' });
  db.prepare('UPDATE logos SET nombre_entidad=? WHERE id=?').run(nombre, id);
  res.json(filaLogo(db.prepare(SELECT_LOGO + ' WHERE id=?').get(id)));
});

app.delete('/api/logos/:id', (req, res) => {
  db.prepare('DELETE FROM logos WHERE id=?').run(Number(req.params.id));
  res.status(204).end();
});

// Subir (o reemplazar) el logo: el cuerpo de la petición es el archivo de imagen tal cual
app.put('/api/logos/:id/imagen', express.raw({ type: () => true, limit: MAX_LOGO }), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM logos WHERE id=?').get(id))
    return res.status(404).json({ error: 'Entidad no encontrada' });
  const archivo = req.body;
  if (!Buffer.isBuffer(archivo) || archivo.length === 0)
    return res.status(400).json({ error: 'No se recibió ninguna imagen' });
  const tipo = tipoImagen(archivo);
  if (!tipo) return res.status(400).json({ error: 'El archivo debe ser una imagen PNG, JPG, WEBP o GIF' });
  db.prepare("UPDATE logos SET logo=?, logo_tipo=?, logo_nombre=?, logo_actualizado=datetime('now') WHERE id=?")
    .run(archivo, tipo, nombreArchivoSeguro(req.headers['x-nombre-archivo']), id);
  res.json(filaLogo(db.prepare(SELECT_LOGO + ' WHERE id=?').get(id)));
});

app.delete('/api/logos/:id/imagen', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM logos WHERE id=?').get(id))
    return res.status(404).json({ error: 'Entidad no encontrada' });
  db.prepare('UPDATE logos SET logo=NULL, logo_tipo=NULL, logo_nombre=NULL, logo_actualizado=NULL WHERE id=?').run(id);
  res.json(filaLogo(db.prepare(SELECT_LOGO + ' WHERE id=?').get(id)));
});

app.get('/api/logos/:id/imagen', (req, res) => {
  const r = db.prepare('SELECT logo, logo_tipo FROM logos WHERE id=?').get(Number(req.params.id));
  if (!r || !r.logo) return res.status(404).json({ error: 'Esta entidad no tiene logo' });
  res.setHeader('Content-Type', r.logo_tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(Buffer.from(r.logo));
});

/* ---------- Administradores ---------- */

// SQLite informa la violación de una llave foránea con distintos códigos según la operación
function esErrorForaneo(e) {
  return e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
         e.code === 'SQLITE_CONSTRAINT_TRIGGER' ||
         /FOREIGN KEY/i.test(String(e.message));
}

const ROLES = ['Administrador', 'Superadministrador'];
const ESTADOS = ['Activo', 'Inactivo', 'Bloqueado'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Nunca se guarda la contraseña: solo un hash con sal ("sal:hash" en hexadecimal)
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// Nunca se devuelve password_hash al navegador
const SELECT_ADMIN = `
  SELECT id, nombre, cargo, email, telefono, rol, estado,
         ultimo_acceso AS acceso, ip_ultimo_acceso AS ip, intentos_fallidos AS fallidos
  FROM administradores`;

function validarAdmin(b, requierePassword) {
  const nombre = String(b.nombre ?? '').trim();
  const cargo = String(b.cargo ?? '').trim();
  const email = String(b.email ?? '').trim();
  const telefono = String(b.telefono ?? '').trim();
  const password = String(b.password ?? '');

  if (!nombre) return { error: 'El nombre es obligatorio' };
  if (!EMAIL_RE.test(email)) return { error: 'Escribe un email válido' };
  if (!ROLES.includes(b.rol)) return { error: 'Rol no válido' };
  if (!ESTADOS.includes(b.estado)) return { error: 'Estado no válido' };
  if ((requierePassword || password) && password.length < 8)
    return { error: 'La contraseña debe tener mínimo 8 caracteres' };

  return { datos: { nombre, cargo, email, telefono, password, rol: b.rol, estado: b.estado } };
}

function esUnicoSuper(id) {
  const a = db.prepare('SELECT rol FROM administradores WHERE id=?').get(id);
  if (!a || a.rol !== 'Superadministrador') return false;
  return db.prepare("SELECT COUNT(*) c FROM administradores WHERE rol='Superadministrador'").get().c === 1;
}

function errorUnico(e) {
  return e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

app.get('/api/administradores', (req, res) =>
  res.json(db.prepare(SELECT_ADMIN + ' ORDER BY id').all()));

app.post('/api/administradores', (req, res) => {
  const v = validarAdmin(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  try {
    const r = db.prepare(`
      INSERT INTO administradores (nombre, cargo, email, telefono, password_hash, rol, estado)
      VALUES (?,?,?,?,?,?,?)`)
      .run(d.nombre, d.cargo, d.email, d.telefono, hashPassword(d.password), d.rol, d.estado);
    res.status(201).json(db.prepare(SELECT_ADMIN + ' WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (errorUnico(e)) return res.status(409).json({ error: 'Ya existe un administrador con ese email' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/administradores/:id', (req, res) => {
  const id = Number(req.params.id);
  const previo = db.prepare('SELECT estado FROM administradores WHERE id=?').get(id);
  if (!previo) return res.status(404).json({ error: 'Administrador no encontrado' });

  const v = validarAdmin(req.body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;

  if (d.rol !== 'Superadministrador' && esUnicoSuper(id))
    return res.status(409).json({ error: 'Debe existir al menos un Superadministrador' });

  try {
    if (d.password) {
      db.prepare(`UPDATE administradores
                  SET nombre=?, cargo=?, email=?, telefono=?, rol=?, estado=?, password_hash=?
                  WHERE id=?`)
        .run(d.nombre, d.cargo, d.email, d.telefono, d.rol, d.estado, hashPassword(d.password), id);
    } else {
      db.prepare(`UPDATE administradores
                  SET nombre=?, cargo=?, email=?, telefono=?, rol=?, estado=?
                  WHERE id=?`)
        .run(d.nombre, d.cargo, d.email, d.telefono, d.rol, d.estado, id);
    }
    if (previo.estado !== 'Activo' && d.estado === 'Activo')
      db.prepare('UPDATE administradores SET intentos_fallidos=0 WHERE id=?').run(id);
    res.json(db.prepare(SELECT_ADMIN + ' WHERE id=?').get(id));
  } catch (e) {
    if (errorUnico(e)) return res.status(409).json({ error: 'Ya existe un administrador con ese email' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/administradores/:id', (req, res) => {
  const id = Number(req.params.id);
  if (esUnicoSuper(id))
    return res.status(409).json({ error: 'No se puede eliminar al único Superadministrador' });
  try {
    db.prepare('DELETE FROM administradores WHERE id=?').run(id);
    res.status(204).end();
  } catch (e) {
    if (esErrorForaneo(e))
      return res.status(409).json({ error: 'Este administrador tiene gestores o metas asignadas. Reasígnalos o elimínalos primero' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ---------- Gestores (asignados a un administrador) ---------- */

const ROLES_GESTOR = ['Gestor', 'Gestor líder'];

const SELECT_GESTOR = `
  SELECT id_gestor AS idg, administrador_id AS adminId, nombre, cargo, email, telefono, rol, estado,
         ultimo_acceso AS acceso, ip_ultimo_acceso AS ip, intentos_fallidos AS fallidos
  FROM gestores`;

function validarGestor(b, requierePassword) {
  const adminId = Number(b.adminId);
  const nombre = String(b.nombre ?? '').trim();
  const cargo = String(b.cargo ?? '').trim();
  const email = String(b.email ?? '').trim();
  const telefono = String(b.telefono ?? '').trim();
  const password = String(b.password ?? '');

  if (!Number.isInteger(adminId) || !db.prepare('SELECT 1 FROM administradores WHERE id=?').get(adminId))
    return { error: 'El administrador seleccionado no existe' };
  if (!nombre) return { error: 'El nombre es obligatorio' };
  if (!EMAIL_RE.test(email)) return { error: 'Escribe un email válido' };
  if (!ROLES_GESTOR.includes(b.rol)) return { error: 'Rol no válido' };
  if (!ESTADOS.includes(b.estado)) return { error: 'Estado no válido' };
  if ((requierePassword || password) && password.length < 8)
    return { error: 'La contraseña debe tener mínimo 8 caracteres' };

  return { datos: { adminId, nombre, cargo, email, telefono, password, rol: b.rol, estado: b.estado } };
}

app.get('/api/gestores', (req, res) =>
  res.json(db.prepare(SELECT_GESTOR + ' ORDER BY id_gestor').all()));

app.post('/api/gestores', (req, res) => {
  const v = validarGestor(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  try {
    const r = db.prepare(`
      INSERT INTO gestores (administrador_id, nombre, cargo, email, telefono, password_hash, rol, estado)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(d.adminId, d.nombre, d.cargo, d.email, d.telefono, hashPassword(d.password), d.rol, d.estado);
    res.status(201).json(db.prepare(SELECT_GESTOR + ' WHERE id_gestor=?').get(r.lastInsertRowid));
  } catch (e) {
    if (errorUnico(e)) return res.status(409).json({ error: 'Ya existe un gestor con ese email' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/gestores/:id', (req, res) => {
  const id = Number(req.params.id);
  const previo = db.prepare('SELECT estado FROM gestores WHERE id_gestor=?').get(id);
  if (!previo) return res.status(404).json({ error: 'Gestor no encontrado' });

  const v = validarGestor(req.body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;

  try {
    if (d.password) {
      db.prepare(`UPDATE gestores
                  SET administrador_id=?, nombre=?, cargo=?, email=?, telefono=?, rol=?, estado=?, password_hash=?
                  WHERE id_gestor=?`)
        .run(d.adminId, d.nombre, d.cargo, d.email, d.telefono, d.rol, d.estado, hashPassword(d.password), id);
    } else {
      db.prepare(`UPDATE gestores
                  SET administrador_id=?, nombre=?, cargo=?, email=?, telefono=?, rol=?, estado=?
                  WHERE id_gestor=?`)
        .run(d.adminId, d.nombre, d.cargo, d.email, d.telefono, d.rol, d.estado, id);
    }
    if (previo.estado !== 'Activo' && d.estado === 'Activo')
      db.prepare('UPDATE gestores SET intentos_fallidos=0 WHERE id_gestor=?').run(id);
    res.json(db.prepare(SELECT_GESTOR + ' WHERE id_gestor=?').get(id));
  } catch (e) {
    if (errorUnico(e)) return res.status(409).json({ error: 'Ya existe un gestor con ese email' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/gestores/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM gestores WHERE id_gestor=?').run(Number(req.params.id));
    res.status(204).end();
  } catch (e) {
    if (esErrorForaneo(e))
      return res.status(409).json({ error: 'Este gestor tiene metas asignadas. Quita las asignaciones primero' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ---------- Sesión de administradores ---------- */

const MAX_INTENTOS = 5;
const DURACION_SESION_S = 8 * 60 * 60;            // 8 horas (se cierra al cerrar el navegador)
const DURACION_RECORDAR_S = 30 * 24 * 60 * 60;    // 30 días si marca «Mantener sesión iniciada»
const COOKIE_SESION = 'sisr_sesion';

// La clave con la que se firman las sesiones se crea una vez y se guarda en la base de datos
let secretoSesion = (db.prepare("SELECT valor FROM ajustes WHERE clave='secreto_sesion'").get() || {}).valor;
if (!secretoSesion) {
  secretoSesion = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('secreto_sesion', ?)").run(secretoSesion);
}

function firmar(texto) {
  return crypto.createHmac('sha256', secretoSesion).update(texto).digest('base64url');
}

function crearToken(adminId, segundos = DURACION_SESION_S) {
  const cuerpo = Buffer.from(JSON.stringify({ id: adminId, exp: Math.floor(Date.now() / 1000) + segundos })).toString('base64url');
  return cuerpo + '.' + firmar(cuerpo);
}

function leerToken(token) {
  const [cuerpo, firma] = String(token || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperada = Buffer.from(firmar(cuerpo));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
  try {
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    return datos.exp > Date.now() / 1000 ? datos : null;
  } catch (e) { return null; }
}

function leerCookie(req, nombre) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) {
      try { return decodeURIComponent(parte.slice(i + 1).trim()); } catch (e) { return null; }
    }
  }
  return null;
}

function verificarPassword(password, almacenado) {
  const [saltHex, hashHex] = String(almacenado).split(':');
  if (!saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), esperado.length);
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

// Devuelve el administrador de la sesión, solo si su cuenta sigue activa
function adminDeSesion(req) {
  const datos = leerToken(leerCookie(req, COOKIE_SESION));
  if (!datos || datos.t) return null;
  return db.prepare("SELECT id, nombre, cargo, email, rol FROM administradores WHERE id=? AND estado='Activo'").get(datos.id) || null;
}

function requiereSesion(req, res, next) {
  const admin = adminDeSesion(req);
  if (!admin) return res.status(401).json({ error: 'Debes iniciar sesión' });
  req.admin = admin;
  next();
}

// Con segundos = null la cookie dura mientras el navegador esté abierto
// Varias cookies en una misma respuesta: se agregan, no se reemplazan
function agregarCookie(res, texto) { res.setHeader('Set-Cookie', [].concat(res.getHeader('Set-Cookie') || [], texto)); }

function ponerCookie(res, valor, segundos) {
  agregarCookie(res, COOKIE_SESION + '=' + valor + '; HttpOnly; SameSite=Lax; Path=/' + (segundos === null ? '' : '; Max-Age=' + segundos));
}

/* ---------- IP del cliente y bitácora de accesos ---------- */
// IP propia (LAN) de este equipo; se usa cuando alguien entra desde el mismo servidor por localhost
function ipLanServidor() {
  for (const lista of Object.values(require('os').networkInterfaces()))
    for (const i of lista || [])
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return '';
}
const esLoopback = ip => ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');

// Orden de decisión:
//  1) Si hay proxy (TRUST_PROXY=1, o un proxy en este mismo equipo que envía X-Forwarded-For), se toma la IP real del encabezado.
//  2) Si no, la dirección del socket.
//  3) Si resulta ser localhost (el usuario abrió http://localhost:3000 en el propio servidor), se muestra la IP LAN del servidor.
function ipCliente(req) {
  let socketIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  let ip = socketIp;
  const proxyConfiable = process.env.TRUST_PROXY || esLoopback(socketIp);
  if (proxyConfiable) {
    // Cloudflare envía CF-Connecting-IP con la IP real del visitante y no se puede falsear desde fuera,
    // por eso va primero; X-Forwarded-For puede traer valores puestos por el propio visitante.
    const xff = String(req.headers['cf-connecting-ip'] || '').trim()
      || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || String(req.headers['x-real-ip'] || '').trim();
    if (xff) ip = xff.replace(/^::ffff:/i, '');
  }
  if (esLoopback(ip)) ip = ipLanServidor() || '127.0.0.1';
  return ip.slice(0, 64);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS bitacora_accesos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT,
    usuario_id INTEGER,
    email TEXT,
    ip TEXT,
    resultado TEXT NOT NULL,
    navegador TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bitacora_usuario ON bitacora_accesos (tipo, usuario_id, fecha);
`);

// resultado: Exitoso · Contraseña incorrecta · Cuenta bloqueada · Cuenta inactiva · Usuario no existe
function registrarAcceso(req, tipo, usuarioId, email, resultado) {
  try {
    // Diagnóstico: se ve en la consola de «node server.js» (se puede quitar cuando ya funcione)
    console.log('[ACCESO] ' + resultado + ' · ' + email + ' · IP guardada=' + ipCliente(req) +
      ' · socket=' + req.socket.remoteAddress + ' · host=' + (req.headers.host || '') +
      ' · x-forwarded-for=' + (req.headers['x-forwarded-for'] || '-'));
    db.prepare('INSERT INTO bitacora_accesos (tipo, usuario_id, email, ip, resultado, navegador) VALUES (?,?,?,?,?,?)')
      .run(tipo, usuarioId, String(email || '').slice(0, 120), ipCliente(req), resultado, String(req.headers['user-agent'] || '').slice(0, 200));
  } catch (e) { console.error('No se pudo registrar el acceso:', e.message); }
}

app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const email = String(b.email ?? '').trim();
  const password = String(b.password ?? '');
  const GENERICO = 'Correo o contraseña incorrectos';

  const a = email && password
    ? db.prepare('SELECT id, nombre, password_hash, estado, intentos_fallidos FROM administradores WHERE email=?').get(email)
    : null;
  if (!a) return loginGestor(req, res);
  if (a.estado === 'Bloqueado') {
    registrarAcceso(req, 'administrador', a.id, email, 'Cuenta bloqueada');
    return res.status(403).json({ error: 'Tu cuenta está bloqueada. Pide a un superadministrador que la active' });
  }

  if (!verificarPassword(password, a.password_hash)) {
    registrarAcceso(req, 'administrador', a.id, email, 'Contraseña incorrecta');
    if (a.estado === 'Activo') {
      const n = a.intentos_fallidos + 1;
      const bloquear = n >= MAX_INTENTOS;
      db.prepare('UPDATE administradores SET intentos_fallidos=?, estado=? WHERE id=?').run(n, bloquear ? 'Bloqueado' : 'Activo', a.id);
      if (bloquear)
        return res.status(403).json({ error: 'Superaste ' + MAX_INTENTOS + ' intentos. Tu cuenta quedó bloqueada; pide a un superadministrador que la active' });
    }
    return res.status(401).json({ error: GENERICO });
  }
  if (a.estado !== 'Activo') {
    registrarAcceso(req, 'administrador', a.id, email, 'Cuenta inactiva');
    return res.status(403).json({ error: 'Tu cuenta está inactiva. Pide a un superadministrador que la active' });
  }

  const ip = ipCliente(req);
  registrarAcceso(req, 'administrador', a.id, email, 'Exitoso');
  db.prepare("UPDATE administradores SET intentos_fallidos=0, ultimo_acceso=datetime('now'), ip_ultimo_acceso=? WHERE id=?").run(ip, a.id);
  const recordar = b.recordar === true;
  const duracion = recordar ? DURACION_RECORDAR_S : DURACION_SESION_S;
  ponerCookie(res, crearToken(a.id, duracion), recordar ? duracion : null);
  cookieGestor(res, '', 0);   // si había un gestor con sesión abierta, se cierra
  res.json({ id: a.id, nombre: a.nombre, tipo: 'admin' });
});

app.post('/api/logout', (req, res) => {
  ponerCookie(res, '', 0);
  cookieGestor(res, '', 0);
  res.status(204).end();
});

app.get('/api/sesion', requiereSesion, (req, res) => res.json(req.admin));

/* ---------- Asignación de responsables (metas ↔ gestores) ---------- */

// Gestores que tiene asignados el administrador de la sesión
app.get('/api/mis-gestores', requiereSesion, (req, res) =>
  res.json(db.prepare('SELECT id_gestor AS idg, nombre, cargo, estado FROM gestores WHERE administrador_id=? ORDER BY nombre').all(req.admin.id)));

// Todas las metas (productos) con su programa y, si la tienen, su asignación
app.get('/api/metas', requiereSesion, (req, res) => {
  const filas = db.prepare(`
    SELECT pr.codigo_producto AS codprod, pr.nombre_producto AS nomprod,
           pr.codigo_indicador_producto AS codind, pr.indicador_producto AS indprod,
           pr.meta_redactada AS metared, pr.linea_base AS lineabase, pr.meta_cuatrienio AS metacuatrienio,
           pg.codigo_programa AS progCodigo, pg.nombre_programa AS progNombre, pg.sector AS sector,
           a.gestor_id AS gestorId, g.nombre AS gestorNombre, a.dependencia AS dependencia,
           a.administrador_id AS adminId, ad.nombre AS registradoPor
    FROM productos pr
    JOIN programas pg ON pg.codigo_programa = pr.codigo_programa
    LEFT JOIN asignaciones a ON a.codigo_producto = pr.codigo_producto
    LEFT JOIN gestores g ON g.id_gestor = a.gestor_id
    LEFT JOIN administradores ad ON ad.id = a.administrador_id
    ORDER BY pg.sector, CAST(pg.codigo_programa AS INTEGER), pg.codigo_programa,
             CAST(pr.codigo_producto AS INTEGER), pr.codigo_producto`).all();

  res.json(filas.map(r => ({
    codprod: r.codprod, nomprod: r.nomprod, codind: r.codind, indprod: r.indprod, metared: r.metared,
    lineabase: r.lineabase, metacuatrienio: r.metacuatrienio,
    progCodigo: r.progCodigo, progNombre: r.progNombre, sector: r.sector,
    asignacion: r.gestorId ? { gestorId: r.gestorId, gestorNombre: r.gestorNombre, dependencia: r.dependencia, registradoPor: r.registradoPor } : null,
    // solo puede quitar la asignación quien la hizo o un superadministrador
    puedeQuitar: !!r.gestorId && (r.adminId === req.admin.id || req.admin.rol === 'Superadministrador')
  })));
});

// Valida el gestor y la dependencia de una asignación (sirve para crear y para editar)
function validarAsignacion(b, admin) {
  const gestorId = Number(b.gestorId);
  const dependencia = String(b.dependencia ?? '').trim().slice(0, 120);

  if (!dependencia) return { status: 400, error: 'La dependencia responsable es obligatoria' };
  const gestor = Number.isInteger(gestorId)
    ? db.prepare('SELECT id_gestor, administrador_id, estado FROM gestores WHERE id_gestor=?').get(gestorId)
    : null;
  if (!gestor) return { status: 400, error: 'El gestor seleccionado no existe' };
  if (gestor.administrador_id !== admin.id)
    return { status: 403, error: 'Ese gestor no está asignado a tu usuario' };
  if (gestor.estado !== 'Activo')
    return { status: 400, error: 'El gestor seleccionado no está activo' };
  return { gestorId, dependencia };
}

const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// Listado de asignaciones: un superadministrador ve todas; los demás ven las que registraron
// y las de su misma área (la dependencia coincide con su cargo)
app.get('/api/asignaciones', requiereSesion, (req, res) => {
  const filas = db.prepare(`
    SELECT a.codigo_producto AS codprod, pr.nombre_producto AS nomprod,
           pr.codigo_indicador_producto AS codind, pr.indicador_producto AS indprod,
           pg.codigo_programa AS progCodigo, pg.nombre_programa AS progNombre, pg.sector AS sector,
           l.id AS lineaId, l.numero_linea_estrategica AS lineaNumero, l.nombre_linea AS lineaNombre,
           a.gestor_id AS gestorId, g.nombre AS gestorNombre, a.dependencia AS dependencia,
           a.administrador_id AS adminId, ad.nombre AS registradoPor, a.creado_en AS fecha
    FROM asignaciones a
    JOIN productos pr ON pr.codigo_producto = a.codigo_producto
    JOIN programas pg ON pg.codigo_programa = pr.codigo_programa
    JOIN lineas_estrategicas l ON l.id = pg.linea_id
    JOIN gestores g ON g.id_gestor = a.gestor_id
    JOIN administradores ad ON ad.id = a.administrador_id
    ORDER BY l.numero_linea_estrategica, CAST(pg.codigo_programa AS INTEGER), pg.codigo_programa,
             CAST(pr.codigo_producto AS INTEGER), pr.codigo_producto`).all();

  const esSuper = req.admin.rol === 'Superadministrador';
  const miArea = norm(req.admin.cargo);
  res.json(filas
    .filter(r => esSuper || r.adminId === req.admin.id || (miArea && norm(r.dependencia) === miArea))
    .map(({ adminId, ...r }) => ({ ...r, puedeEditar: esSuper || adminId === req.admin.id })));
});

app.post('/api/asignaciones', requiereSesion, (req, res) => {
  const b = req.body || {};
  const codprod = String(b.codprod ?? '').trim();

  if (!db.prepare('SELECT 1 FROM productos WHERE codigo_producto=?').get(codprod))
    return res.status(400).json({ error: 'La meta seleccionada no existe' });
  const v = validarAsignacion(b, req.admin);
  if (v.error) return res.status(v.status).json({ error: v.error });

  try {
    db.prepare('INSERT INTO asignaciones (codigo_producto, gestor_id, administrador_id, dependencia) VALUES (?,?,?,?)')
      .run(codprod, v.gestorId, req.admin.id, v.dependencia);
    res.status(201).json({ codprod, gestorId: v.gestorId, dependencia: v.dependencia });
  } catch (e) {
    if (errorUnico(e)) return res.status(409).json({ error: 'Esa meta ya está asignada. Actualiza la página' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Editar (reasignar) una meta: cambia el gestor y/o la dependencia
app.put('/api/asignaciones/:codprod', requiereSesion, (req, res) => {
  const codprod = req.params.codprod;
  const a = db.prepare('SELECT administrador_id FROM asignaciones WHERE codigo_producto=?').get(codprod);
  if (!a) return res.status(404).json({ error: 'Esa meta no tiene asignación' });
  if (a.administrador_id !== req.admin.id && req.admin.rol !== 'Superadministrador')
    return res.status(403).json({ error: 'Solo quien hizo la asignación o un superadministrador puede editarla' });

  const v = validarAsignacion(req.body || {}, req.admin);
  if (v.error) return res.status(v.status).json({ error: v.error });

  db.prepare('UPDATE asignaciones SET gestor_id=?, administrador_id=?, dependencia=? WHERE codigo_producto=?')
    .run(v.gestorId, req.admin.id, v.dependencia, codprod);
  res.json({ codprod, gestorId: v.gestorId, dependencia: v.dependencia });
});

app.delete('/api/asignaciones/:codprod', requiereSesion, (req, res) => {
  const a = db.prepare('SELECT administrador_id FROM asignaciones WHERE codigo_producto=?').get(req.params.codprod);
  if (!a) return res.status(404).json({ error: 'Esa meta no tiene asignación' });
  if (a.administrador_id !== req.admin.id && req.admin.rol !== 'Superadministrador')
    return res.status(403).json({ error: 'Solo quien hizo la asignación o un superadministrador puede quitarla' });
  db.prepare('DELETE FROM asignaciones WHERE codigo_producto=?').run(req.params.codprod);
  res.status(204).end();
});

/* =====================================================================
   GESTORES: SESIÓN, INDICADORES ASIGNADOS Y REGISTRO DE AVANCE
   ===================================================================== */

const COOKIE_GESTOR = 'sisr_gestor';

function gestorDeSesion(req) {
  const datos = leerToken(leerCookie(req, COOKIE_GESTOR));
  if (!datos || datos.t !== 'g') return null;
  return db.prepare("SELECT id_gestor AS id, nombre, cargo, email, rol FROM gestores WHERE id_gestor=? AND estado='Activo'").get(datos.g) || null;
}

function requiereGestor(req, res, next) {
  const g = gestorDeSesion(req);
  if (!g) return res.status(401).json({ error: 'Debes iniciar sesión' });
  req.gestor = g;
  next();
}

function cookieGestor(res, valor, segundos) {
  agregarCookie(res, COOKIE_GESTOR + '=' + valor + '; HttpOnly; SameSite=Lax; Path=/' + (segundos === null ? '' : '; Max-Age=' + segundos));
}

// Segunda parte de POST /api/login: si el correo no es de un administrador, se busca entre los gestores
function loginGestor(req, res) {
  const b = req.body || {};
  const email = String(b.email ?? '').trim();
  const password = String(b.password ?? '');
  const GENERICO = 'Correo o contraseña incorrectos';
  const g = email && password
    ? db.prepare('SELECT id_gestor, password_hash, estado, intentos_fallidos FROM gestores WHERE email=?').get(email)
    : null;
  if (!g) {
    registrarAcceso(req, null, null, email, 'Usuario no existe');
    return res.status(401).json({ error: GENERICO });
  }
  if (g.estado === 'Bloqueado') {
    registrarAcceso(req, 'gestor', g.id_gestor, email, 'Cuenta bloqueada');
    return res.status(403).json({ error: 'Tu cuenta está bloqueada. Pide a tu administrador que la active' });
  }

  if (!verificarPassword(password, g.password_hash)) {
    registrarAcceso(req, 'gestor', g.id_gestor, email, 'Contraseña incorrecta');
    if (g.estado === 'Activo') {
      const n = g.intentos_fallidos + 1;
      const bloquear = n >= MAX_INTENTOS;
      db.prepare('UPDATE gestores SET intentos_fallidos=?, estado=? WHERE id_gestor=?').run(n, bloquear ? 'Bloqueado' : 'Activo', g.id_gestor);
      if (bloquear)
        return res.status(403).json({ error: 'Superaste ' + MAX_INTENTOS + ' intentos. Tu cuenta quedó bloqueada; pide a tu administrador que la active' });
    }
    return res.status(401).json({ error: GENERICO });
  }
  if (g.estado !== 'Activo') {
    registrarAcceso(req, 'gestor', g.id_gestor, email, 'Cuenta inactiva');
    return res.status(403).json({ error: 'Tu cuenta está inactiva. Pide a tu administrador que la active' });
  }

  const ip = ipCliente(req);
  registrarAcceso(req, 'gestor', g.id_gestor, email, 'Exitoso');
  db.prepare("UPDATE gestores SET intentos_fallidos=0, ultimo_acceso=datetime('now'), ip_ultimo_acceso=? WHERE id_gestor=?").run(ip, g.id_gestor);
  const recordar = b.recordar === true;
  const duracion = recordar ? DURACION_RECORDAR_S : DURACION_SESION_S;
  const cuerpo = Buffer.from(JSON.stringify({ g: g.id_gestor, t: 'g', exp: Math.floor(Date.now() / 1000) + duracion })).toString('base64url');
  cookieGestor(res, cuerpo + '.' + firmar(cuerpo), recordar ? duracion : null);
  ponerCookie(res, '', 0);   // si había un administrador con sesión abierta, se cierra
  res.json({ id: g.id_gestor, tipo: 'gestor' });
}

app.post('/api/gestor/logout', (req, res) => {
  cookieGestor(res, '', 0);
  ponerCookie(res, '', 0);
  res.status(204).end();
});

app.get('/api/gestor/sesion', requiereGestor, (req, res) => res.json(req.gestor));

/* ---------- Cambio de contraseña por el propio usuario (administradores y gestores) ---------- */
// Límite de intentos con la contraseña actual equivocada: 5 por usuario cada 15 minutos
const intentosCambioPw = new Map();
function limiteCambioPw(clave) {
  const ahora = Date.now();
  const r = intentosCambioPw.get(clave);
  if (!r || ahora - r.desde > 15 * 60 * 1000) { intentosCambioPw.set(clave, { n: 0, desde: ahora }); return intentosCambioPw.get(clave); }
  return r;
}

app.post('/api/cambiar-password', (req, res) => {
  // La sesión decide de quién es la cuenta: nunca se recibe un id desde el navegador
  const admin = adminDeSesion(req);
  const gestor = admin ? null : gestorDeSesion(req);
  if (!admin && !gestor) return res.status(401).json({ error: 'Debes iniciar sesión' });
  const tipo = admin ? 'administrador' : 'gestor';
  const id = admin ? admin.id : gestor.id;
  const email = admin ? admin.email : gestor.email;

  const b = req.body || {};
  const actual = String(b.actual ?? '');
  const nueva = String(b.nueva ?? '');
  if (!actual) return res.status(400).json({ error: 'Escribe tu contraseña actual' });
  if (nueva.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 8 caracteres' });
  if (nueva.length > 128) return res.status(400).json({ error: 'La nueva contraseña es demasiado larga (máximo 128 caracteres)' });

  const lim = limiteCambioPw(tipo + ':' + id);
  if (lim.n >= 5) return res.status(429).json({ error: 'Demasiados intentos con la contraseña actual. Espera unos minutos e inténtalo de nuevo' });

  const fila = admin
    ? db.prepare('SELECT password_hash FROM administradores WHERE id=?').get(id)
    : db.prepare('SELECT password_hash FROM gestores WHERE id_gestor=?').get(id);
  if (!fila || !verificarPassword(actual, fila.password_hash)) {
    lim.n++;
    registrarAcceso(req, tipo, id, email, 'Cambio de contraseña fallido');
    return res.status(403).json({ error: 'La contraseña actual no es correcta' });
  }
  if (nueva === actual) return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });

  const hash = hashPassword(nueva);
  if (admin) db.prepare('UPDATE administradores SET password_hash=?, intentos_fallidos=0 WHERE id=?').run(hash, id);
  else db.prepare('UPDATE gestores SET password_hash=?, intentos_fallidos=0 WHERE id_gestor=?').run(hash, id);
  intentosCambioPw.delete(tipo + ':' + id);
  registrarAcceso(req, tipo, id, email, 'Contraseña cambiada');
  res.json({ ok: true });
});

// Indicadores que el gestor de la sesión tiene asignados (tabla asignaciones)
app.get('/api/gestor/indicadores', requiereGestor, (req, res) =>
  res.json(db.prepare(`
    SELECT pr.codigo_producto AS codprod, pr.nombre_producto AS nomprod,
           pr.codigo_indicador_producto AS codind, pr.indicador_producto AS indprod,
           pr.meta_redactada AS metared, pr.linea_base AS lineabase,
           pr.meta_cuatrienio AS metacuatrienio, a.dependencia AS dependencia,
           COALESCE((SELECT SUM(c.avance_reportado) FROM cumplimientos c
                     WHERE c.codigo_producto = pr.codigo_producto AND c.estado_revision IN ('Pendiente','Aprobado')), 0) AS acumulado
    FROM asignaciones a
    JOIN productos pr ON pr.codigo_producto = a.codigo_producto
    WHERE a.gestor_id = ?
    ORDER BY CAST(pr.codigo_producto AS INTEGER), pr.codigo_producto`).all(req.gestor.id).map(i => {
    const acumulado = Math.round(i.acumulado * 1e6) / 1e6;
    return { ...i, acumulado, cumplida: i.metacuatrienio > 0 && acumulado >= i.metacuatrienio };
  })));

// Avances del gestor de la sesión, en todos los estados (el WHERE por gestor_id es lo que garantiza que solo vea los suyos)
app.get('/api/gestor/cumplimientos', requiereGestor, (req, res) =>
  res.json(db.prepare(`
    SELECT c.id_cumplimiento AS id, pr.codigo_indicador_producto AS codind, c.periodo AS periodicidad,
           COALESCE(NULLIF(TRIM(pr.meta_redactada), ''), pr.nombre_producto) AS meta, pr.meta_cuatrienio AS metacuatrienio,
           c.avance_reportado AS avance, c.porcentaje_cumplimiento AS porcentaje, c.estado_revision AS estado,
           c.fecha_registro AS fecha, c.fecha_revision AS fechaRevision, c.observacion_revision AS observacion
    FROM cumplimientos c JOIN productos pr ON pr.codigo_producto = c.codigo_producto
    WHERE c.gestor_id = ? ORDER BY c.id_cumplimiento DESC`).all(req.gestor.id)));

/* ---------- Cumplimientos y evidencias ---------- */

const PERIODOS = ['Mensual', 'Trimestral'];
const MAX_EVIDENCIA = '10mb';
const MAX_ARCHIVOS = 10;

const SELECT_CUMPLIMIENTO = `
  SELECT c.id_cumplimiento AS id, c.codigo_producto AS codprod, c.periodo,
         c.avance_reportado AS avance, c.porcentaje_cumplimiento AS porcentaje,
         c.estado_revision AS estado, c.fecha_registro AS fecha,
         c.logro_alcanzado AS logro, CAST(c.poblacion_beneficiada AS TEXT) AS poblacion,
         (SELECT COUNT(*) FROM evidencias e WHERE e.id_cumplimiento = c.id_cumplimiento) AS numEvidencias
  FROM cumplimientos c`;

// Un gestor solo ve y modifica sus propios registros
function propio(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id)
    ? db.prepare(SELECT_CUMPLIMIENTO + ' WHERE c.id_cumplimiento=? AND c.gestor_id=?').get(id, req.gestor.id) || null
    : null;
}

const editable = c => c.estado === 'Borrador' || c.estado === 'Devuelto';

function numeroOpcional(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const MSG_META_CUMPLIDA = 'Esta meta ya alcanzó el 100 % de cumplimiento; no se admiten más registros.';

// Avance ya registrado sobre un indicador: suma de los registros enviados (Pendiente) o aprobados.
// Un borrador o un registro devuelto no cuenta. Se excluye el registro que se está editando.
function avanceAcumulado(codprod, excluirId = 0) {
  const t = db.prepare("SELECT COALESCE(SUM(avance_reportado), 0) AS t FROM cumplimientos WHERE codigo_producto=? AND id_cumplimiento<>? AND estado_revision IN ('Pendiente','Aprobado')")
    .get(codprod, excluirId).t;
  return Math.round(t * 1e6) / 1e6;
}

const metaDe = codprod => db.prepare('SELECT meta_cuatrienio FROM productos WHERE codigo_producto=?').get(codprod).meta_cuatrienio;

function metaCumplida(codprod, excluirId = 0) {
  const meta = metaDe(codprod);
  return meta > 0 && avanceAcumulado(codprod, excluirId) >= meta;
}

// Porcentaje acumulado = (avance ya registrado + este avance) ÷ meta del cuatrienio × 100.
// El total nunca puede superar la meta.
function porcentajeAcumulado(codprod, avance, excluirId = 0) {
  const meta = metaDe(codprod), previo = avanceAcumulado(codprod, excluirId);
  if (!(meta > 0)) return { error: 'Este indicador no tiene meta del cuatrienio; avisa a tu administrador' };
  const falta = Math.round((meta - previo) * 1e6) / 1e6;
  if (avance > falta)
    return { error: 'El avance reportado (' + avance + ') supera lo que falta para cumplir la meta: ya hay ' + previo + ' registrados de ' + meta + '. Máximo permitido: ' + falta + '.' };
  return { porcentaje: Math.round((previo + avance) / meta * 1000) / 10 };
}

const MAX_LOGRO = 1000, MAX_POBLACION = 100;

function validarCumplimiento(b, gestorId, idActual = 0) {
  const codprod = String(b.codprod ?? '').trim();
  const periodo = b.periodo ? String(b.periodo) : null;
  const avance = numeroOpcional(b.avance);

  if (!db.prepare('SELECT 1 FROM asignaciones WHERE codigo_producto=? AND gestor_id=?').get(codprod, gestorId))
    return { error: 'Ese indicador no está asignado a tu usuario' };
  if (metaCumplida(codprod, idActual)) return { error: MSG_META_CUMPLIDA };
  if (periodo === null) return { error: 'Selecciona el periodo' };
  if (!PERIODOS.includes(periodo)) return { error: 'El periodo no es válido' };
  if (avance === null) return { error: 'Escribe el avance reportado' };
  if (Number.isNaN(avance) || (avance !== null && avance < 0)) return { error: 'El avance debe ser un número mayor o igual a 0' };

  const logro = String(b.logro ?? '').trim();
  if (!logro) return { error: 'Describe el logro alcanzado' };
  if (logro.length > MAX_LOGRO) return { error: 'El logro alcanzado no puede superar los ' + MAX_LOGRO + ' caracteres' };
  const poblacion = String(b.poblacion ?? '').trim();
  if (!poblacion) return { error: 'Escribe la cantidad de población beneficiada (si no hubo, escribe 0)' };
  if (poblacion.length > MAX_POBLACION) return { error: 'La población beneficiada no puede superar los ' + MAX_POBLACION + ' caracteres' };

  // El porcentaje no lo escribe el gestor: se calcula con el avance acumulado de la meta
  const r = porcentajeAcumulado(codprod, avance, idActual);
  if (r.error) return { error: r.error };
  return { datos: { codprod, periodo, avance, porcentaje: r.porcentaje, logro, poblacion } };
}

app.post('/api/cumplimientos', requiereGestor, (req, res) => {
  const v = validarCumplimiento(req.body || {}, req.gestor.id);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  const r = db.prepare('INSERT INTO cumplimientos (gestor_id, codigo_producto, periodo, avance_reportado, porcentaje_cumplimiento, logro_alcanzado, poblacion_beneficiada) VALUES (?,?,?,?,?,?,?)')
    .run(req.gestor.id, d.codprod, d.periodo, d.avance, d.porcentaje, d.logro, d.poblacion);
  res.status(201).json(db.prepare(SELECT_CUMPLIMIENTO + ' WHERE c.id_cumplimiento=?').get(r.lastInsertRowid));
});

app.put('/api/cumplimientos/:id', requiereGestor, (req, res) => {
  const c = propio(req);
  if (!c) return res.status(404).json({ error: 'Registro no encontrado' });
  if (!editable(c)) return res.status(409).json({ error: 'Este registro ya fue enviado a revisión y no se puede modificar' });
  const v = validarCumplimiento(req.body || {}, req.gestor.id, c.id);
  if (v.error) return res.status(400).json({ error: v.error });
  const d = v.datos;
  db.prepare("UPDATE cumplimientos SET codigo_producto=?, periodo=?, avance_reportado=?, porcentaje_cumplimiento=?, logro_alcanzado=?, poblacion_beneficiada=?, actualizado_en=datetime('now') WHERE id_cumplimiento=?")
    .run(d.codprod, d.periodo, d.avance, d.porcentaje, d.logro, d.poblacion, c.id);
  res.json(db.prepare(SELECT_CUMPLIMIENTO + ' WHERE c.id_cumplimiento=?').get(c.id));
});

// El tipo se deduce de los primeros bytes del archivo: JPG, PNG o PDF
function tipoEvidencia(b) {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  const t = tipoImagen(b);
  return t === 'image/png' || t === 'image/jpeg' ? t : null;
}

const recibirEvidencia = (req, res, next) =>
  express.raw({ type: () => true, limit: MAX_EVIDENCIA })(req, res, err => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo supera el máximo de 10 MB' });
    next(err);
  });

// Un archivo por petición (el cuerpo es el archivo tal cual); la página llama una vez por archivo
app.post('/api/cumplimientos/:id/evidencias', requiereGestor, recibirEvidencia, (req, res) => {
  const c = propio(req);
  if (!c) return res.status(404).json({ error: 'Registro no encontrado' });
  if (!editable(c)) return res.status(409).json({ error: 'Este registro ya fue enviado a revisión' });
  if (c.numEvidencias >= MAX_ARCHIVOS) return res.status(409).json({ error: 'Máximo ' + MAX_ARCHIVOS + ' archivos por registro' });
  const archivo = req.body;
  if (!Buffer.isBuffer(archivo) || archivo.length === 0) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  const tipo = tipoEvidencia(archivo);
  if (!tipo) return res.status(400).json({ error: 'El archivo debe ser JPG, PNG o PDF' });
  const cab = req.headers['x-nombre-archivo'];
  const r = db.prepare('INSERT INTO evidencias (id_cumplimiento, nombre_archivo, tipo, archivo, tamano) VALUES (?,?,?,?,?)')
    .run(c.id, cab ? nombreArchivoSeguro(cab) : 'evidencia', tipo, archivo, archivo.length);
  res.status(201).json({ id: r.lastInsertRowid, tipo, tamano: archivo.length });
});

app.post('/api/cumplimientos/:id/enviar', requiereGestor, (req, res) => {
  const c = propio(req);
  if (!c) return res.status(404).json({ error: 'Registro no encontrado' });
  if (!editable(c)) return res.status(409).json({ error: 'Este registro ya fue enviado a revisión' });
  if (!c.periodo || c.avance === null || c.porcentaje === null)
    return res.status(400).json({ error: 'Completa el periodo y el avance antes de enviar' });
  if (!c.logro || c.poblacion === null || c.poblacion === '') return res.status(400).json({ error: 'Completa el logro alcanzado y la población beneficiada antes de enviar' });
  if (!c.numEvidencias) return res.status(400).json({ error: 'Adjunta al menos un archivo de evidencia' });
  if (!db.prepare('SELECT 1 FROM asignaciones WHERE codigo_producto=? AND gestor_id=?').get(c.codprod, req.gestor.id))
    return res.status(409).json({ error: 'Ese indicador ya no está asignado a tu usuario' });
  if (metaCumplida(c.codprod, c.id)) return res.status(409).json({ error: MSG_META_CUMPLIDA });
  // Se recalcula: desde que se guardó el borrador pudieron enviarse otros avances de la misma meta
  const r = porcentajeAcumulado(c.codprod, c.avance, c.id);
  if (r.error) return res.status(409).json({ error: r.error });
  db.prepare("UPDATE cumplimientos SET estado_revision='Pendiente', porcentaje_cumplimiento=?, actualizado_en=datetime('now') WHERE id_cumplimiento=?").run(r.porcentaje, c.id);
  res.json({ id: c.id, estado: 'Pendiente', porcentaje: r.porcentaje });
});

// Un avance del gestor con sus evidencias (al abrirlo desde «Estado de cumplimientos»)
app.get('/api/gestor/cumplimientos/:id', requiereGestor, (req, res) => {
  const c = propio(req);
  if (!c) return res.status(404).json({ error: 'Registro no encontrado' });
  const extra = db.prepare('SELECT observacion_revision AS observacion, fecha_revision AS fechaRevision FROM cumplimientos WHERE id_cumplimiento=?').get(c.id);
  const evidencias = db.prepare('SELECT id_evidencia AS id, nombre_archivo AS nombre, tipo, tamano FROM evidencias WHERE id_cumplimiento=? ORDER BY id_evidencia').all(c.id);
  res.json({ ...c, ...extra, evidencias });
});

/* =====================================================================
   REVISIÓN Y APROBACIÓN DE AVANCES (administradores)
   ===================================================================== */

// Un administrador revisa los avances de los gestores a su cargo; el superadministrador, los de todos
const alcanceRevision = admin => admin.rol === 'Superadministrador'
  ? { sql: '1=1', args: [] }
  : { sql: 'g.administrador_id = ?', args: [admin.id] };

app.get('/api/revision/gestores', requiereSesion, (req, res) => {
  const al = alcanceRevision(req.admin);
  res.json(db.prepare('SELECT g.id_gestor AS id, g.nombre FROM gestores g WHERE ' + al.sql + ' ORDER BY g.nombre').all(...al.args));
});

app.get('/api/revision/resumen', requiereSesion, (req, res) => {
  const al = alcanceRevision(req.admin);
  const n = cond => db.prepare('SELECT COUNT(*) c FROM cumplimientos c JOIN gestores g ON g.id_gestor = c.gestor_id WHERE ' + al.sql + ' AND ' + cond).get(...al.args).c;
  res.json({
    pendientes: n("c.estado_revision='Pendiente'"),
    aprobadosSemana: n("c.estado_revision='Aprobado' AND c.fecha_revision >= datetime('now','-7 days')"),
    devueltos: n("c.estado_revision='Devuelto'")
  });
});

// Los borradores no se muestran: solo lo que el gestor ya envió a revisión
app.get('/api/revision/avances', requiereSesion, (req, res) => {
  const al = alcanceRevision(req.admin), q = req.query;
  const cond = [al.sql, "c.estado_revision <> 'Borrador'"], args = [...al.args];
  if (['Pendiente', 'Aprobado', 'Devuelto'].includes(q.estado)) { cond.push('c.estado_revision=?'); args.push(q.estado); }
  if (PERIODOS.includes(q.periodo)) { cond.push('c.periodo=?'); args.push(q.periodo); }
  if (Number.isInteger(Number(q.gestor)) && Number(q.gestor) > 0) { cond.push('c.gestor_id=?'); args.push(Number(q.gestor)); }
  const t = String(q.q ?? '').trim();
  if (t) { cond.push('(g.nombre LIKE ? OR pr.codigo_indicador_producto LIKE ? OR CAST(c.id_cumplimiento AS TEXT)=?)'); args.push('%' + t + '%', '%' + t + '%', t); }
  const filas = db.prepare(`
    SELECT c.id_cumplimiento AS id, c.gestor_id AS gestorId, g.nombre AS gestorNombre,
           pr.codigo_indicador_producto AS codind, pr.indicador_producto AS indprod,
           pr.nombre_producto AS nomprod, pr.meta_redactada AS metared, pr.meta_cuatrienio AS metacuatrienio,
           c.periodo, c.avance_reportado AS avance, c.porcentaje_cumplimiento AS porcentaje,
           c.logro_alcanzado AS logro, CAST(c.poblacion_beneficiada AS TEXT) AS poblacion,
           c.estado_revision AS estado, c.fecha_registro AS fecha,
           c.observacion_revision AS observacion, c.fecha_revision AS fechaRevision
    FROM cumplimientos c
    JOIN gestores g ON g.id_gestor = c.gestor_id
    JOIN productos pr ON pr.codigo_producto = c.codigo_producto
    WHERE ` + cond.join(' AND ') + ` ORDER BY (c.estado_revision='Pendiente') DESC, c.id_cumplimiento DESC LIMIT 200`).all(...args);
  const porId = {};
  if (filas.length) {
    db.prepare('SELECT id_evidencia AS id, id_cumplimiento AS cid, nombre_archivo AS nombre, tipo, tamano, creado_en AS creado FROM evidencias WHERE id_cumplimiento IN (' + filas.map(() => '?').join(',') + ') ORDER BY id_evidencia')
      .all(...filas.map(f => f.id)).forEach(e => (porId[e.cid] ||= []).push(e));
  }
  res.json(filas.map(f => ({ ...f, evidencias: porId[f.id] || [] })));
});

// Un avance solo es accesible si es de un gestor dentro del alcance del administrador
function avanceEnAlcance(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  const al = alcanceRevision(req.admin);
  return db.prepare("SELECT c.id_cumplimiento AS id, c.estado_revision AS estado FROM cumplimientos c JOIN gestores g ON g.id_gestor = c.gestor_id WHERE c.id_cumplimiento=? AND c.estado_revision <> 'Borrador' AND " + al.sql)
    .get(id, ...al.args) || null;
}

app.get('/api/revision/avances/:id/evidencias/:idev', requiereSesion, (req, res) => {
  const c = avanceEnAlcance(req);
  const e = c && db.prepare('SELECT nombre_archivo, tipo, archivo FROM evidencias WHERE id_evidencia=? AND id_cumplimiento=?').get(Number(req.params.idev), c.id);
  if (!e) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.setHeader('Content-Type', e.tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(e.nombre_archivo));
  res.setHeader('Cache-Control', 'private, no-cache');
  res.end(Buffer.from(e.archivo));
});

function decidirAvance(req, res, estado) {
  const c = avanceEnAlcance(req);
  if (!c) return res.status(404).json({ error: 'Avance no encontrado' });
  if (c.estado !== 'Pendiente') return res.status(409).json({ error: 'Este avance ya fue revisado' });
  const obs = String((req.body || {}).observacion ?? '').trim().slice(0, 1000);
  if (estado === 'Devuelto' && !obs) return res.status(400).json({ error: 'Escribe una observación para devolver el avance al gestor' });
  db.prepare("UPDATE cumplimientos SET estado_revision=?, observacion_revision=?, revisado_por=?, fecha_revision=datetime('now'), actualizado_en=datetime('now') WHERE id_cumplimiento=?")
    .run(estado, obs || null, req.admin.id, c.id);
  res.json({ id: c.id, estado });
}
app.post('/api/revision/avances/:id/aprobar', requiereSesion, (req, res) => decidirAvance(req, res, 'Aprobado'));
app.post('/api/revision/avances/:id/devolver', requiereSesion, (req, res) => decidirAvance(req, res, 'Devuelto'));

/* =====================================================================
   BITÁCORA DE AUDITORÍA DE ACCESOS (solo superadministrador)
   ===================================================================== */

function soloSuper(req, res, next) {
  requiereSesion(req, res, () => {
    if (req.admin.rol !== 'Superadministrador')
      return res.status(403).json({ error: 'Esta sección es solo para el superadministrador' });
    next();
  });
}

// Administradores y gestores en una sola lista de usuarios
const USUARIOS_SQL = `
  SELECT 'admin' AS tipo, a.id AS id, a.nombre AS nombre, a.cargo AS cargo, a.email AS email, a.telefono AS telefono,
         a.rol AS rol, a.estado AS estado, a.ultimo_acceso AS ultimoAcceso, a.ip_ultimo_acceso AS ip,
         a.intentos_fallidos AS intentos, a.creado_en AS creado, NULL AS responsable
  FROM administradores a
  UNION ALL
  SELECT 'gestor', g.id_gestor, g.nombre, g.cargo, g.email, g.telefono, g.rol, g.estado, g.ultimo_acceso,
         g.ip_ultimo_acceso, g.intentos_fallidos, g.creado_en, ad.nombre
  FROM gestores g JOIN administradores ad ON ad.id = g.administrador_id`;

app.get('/api/auditoria/resumen', soloSuper, (req, res) => {
  res.json(db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(estado='Activo'), 0) AS activas,
           COALESCE(SUM(estado='Bloqueado'), 0) AS bloqueadas,
           COALESCE(SUM(intentos >= 4), 0) AS intentosAltos
    FROM (` + USUARIOS_SQL + `)`).get());
});

app.get('/api/auditoria/usuarios', soloSuper, (req, res) => {
  const q = req.query, cond = ['1=1'], args = [];
  if (['Superadministrador', 'Administrador', 'Gestor líder', 'Gestor'].includes(q.rol)) { cond.push('rol=?'); args.push(q.rol); }
  if (['Activo', 'Inactivo', 'Bloqueado'].includes(q.estado)) { cond.push('estado=?'); args.push(q.estado); }
  const fecha = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;   // el navegador envía el día elegido como rango en UTC
  if (fecha.test(q.desde) && fecha.test(q.hasta)) { cond.push('ultimoAcceso >= ? AND ultimoAcceso < ?'); args.push(q.desde, q.hasta); }
  const t = String(q.q ?? '').trim();
  if (t) { cond.push('(nombre LIKE ? OR email LIKE ? OR ip LIKE ?)'); args.push('%' + t + '%', '%' + t + '%', '%' + t + '%'); }
  res.json(db.prepare('SELECT * FROM (' + USUARIOS_SQL + ') WHERE ' + cond.join(' AND ') + ' ORDER BY (ultimoAcceso IS NULL), ultimoAcceso DESC, nombre LIMIT 500').all(...args));
});

const desbloquearCuenta = (req, res) => {
  const tabla = { admin: ['administradores', 'id'], administrador: ['administradores', 'id'], gestor: ['gestores', 'id_gestor'] }[req.params.tipo];
  const id = Number(req.params.id);
  if (!tabla || !Number.isInteger(id)) return res.status(404).json({ error: 'Usuario no encontrado' });
  const u = db.prepare('SELECT estado FROM ' + tabla[0] + ' WHERE ' + tabla[1] + '=?').get(id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.estado !== 'Bloqueado') return res.status(409).json({ error: 'La cuenta no está bloqueada' });
  db.prepare("UPDATE " + tabla[0] + " SET estado='Activo', intentos_fallidos=0 WHERE " + tabla[1] + '=?').run(id);
  res.json({ ok: true });
};
app.post('/api/auditoria/usuarios/:tipo/:id/desbloquear', soloSuper, desbloquearCuenta);   // auditoria-accesos.html
app.post('/api/auditoria/:tipo/:id/desbloquear', soloSuper, desbloquearCuenta);            // seguridad-auditoria.html

// seguridad-auditoria.html: últimos intentos de acceso (con IP) de un usuario
app.get('/api/auditoria/:tipo/:id/historial', soloSuper, (req, res) => {
  const tipo = req.params.tipo === 'admin' ? 'administrador' : req.params.tipo;
  const id = Number(req.params.id);
  if (!['administrador', 'gestor'].includes(tipo) || !Number.isInteger(id)) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(db.prepare('SELECT fecha, ip, resultado, navegador FROM bitacora_accesos WHERE tipo=? AND usuario_id=? ORDER BY id DESC LIMIT 25').all(tipo, id));
});

// seguridad-auditoria.html: todos los usuarios (administradores y gestores) en una sola lista; filtra y ordena el navegador
app.get('/api/auditoria', soloSuper, (req, res) => {
  res.json(db.prepare(`
    SELECT 'administrador' AS tipo, a.id AS id, 'administrador-' || a.id AS clave, a.nombre AS nombre, a.cargo AS cargo, a.email AS email,
           a.telefono AS telefono, a.rol AS rol, a.estado AS estado, a.ultimo_acceso AS acceso, a.ip_ultimo_acceso AS ip,
           a.intentos_fallidos AS fallidos, a.creado_en AS creado, NULL AS administradorNombre,
           (SELECT COUNT(*) FROM gestores x WHERE x.administrador_id = a.id) AS gestoresACargo
    FROM administradores a
    UNION ALL
    SELECT 'gestor', g.id_gestor, 'gestor-' || g.id_gestor, g.nombre, g.cargo, g.email, g.telefono, g.rol, g.estado,
           g.ultimo_acceso, g.ip_ultimo_acceso, g.intentos_fallidos, g.creado_en, ad.nombre, NULL
    FROM gestores g JOIN administradores ad ON ad.id = g.administrador_id`).all());
});

/* =====================================================================
   TABLERO GENERAL DE CUMPLIMIENTOS (administradores y gestores)
   El cumplimiento se calcula con los avances APROBADOS sobre la meta del cuatrienio.
   Superadministrador: todos los sectores · Administrador: los de los gestores a su cargo ·
   Gestor / gestor líder: los de sus propias metas asignadas.
   ===================================================================== */
app.get('/api/tablero', (req, res) => {
  const admin = adminDeSesion(req), gestor = admin ? null : gestorDeSesion(req);
  if (!admin && !gestor) return res.status(401).json({ error: 'Debes iniciar sesión' });

  let alcance = '1=1', args = [], ambito = 'Todos los sectores';
  if (admin && admin.rol !== 'Superadministrador') { alcance = 'g.administrador_id = ?'; args = [admin.id]; ambito = 'Sectores a su cargo'; }
  if (gestor) { alcance = 'g.id_gestor = ?'; args = [gestor.id]; ambito = 'Sus sectores asignados'; }
  const rol = admin ? admin.rol : gestor.rol;

  // Metas (indicadores) asignadas dentro del alcance, con su sector
  const todas = db.prepare(`
    SELECT pr.codigo_producto AS cod, pr.meta_cuatrienio AS meta, COALESCE(NULLIF(TRIM(pg.sector), ''), 'Sin sector') AS sector,
           g.nombre AS gestor, ad.nombre AS admin
    FROM asignaciones a
    JOIN gestores g ON g.id_gestor = a.gestor_id
    JOIN administradores ad ON ad.id = g.administrador_id
    JOIN productos pr ON pr.codigo_producto = a.codigo_producto
    JOIN programas pg ON pg.codigo_programa = pr.codigo_programa
    WHERE ` + alcance).all(...args);
  const sectores = [...new Set(todas.map(m => m.sector))].sort((a, b) => a.localeCompare(b, 'es'));
  const sector = sectores.includes(req.query.sector) ? req.query.sector : '';
  const metas = sector ? todas.filter(m => m.sector === sector) : todas;

  // Periodos: acumulado del año en curso, o hasta el cierre de un trimestre ya iniciado
  const hoy = new Date(), anio = hoy.getFullYear(), trimActual = Math.floor(hoy.getMonth() / 3) + 1, p2 = n => String(n).padStart(2, '0');
  const fin = t => anio + '-' + p2(t * 3) + '-31', inicio = t => anio + '-' + p2((t - 1) * 3 + 1) + '-01';
  const periodos = [{ valor: 'actual', etiqueta: 'Año ' + anio + ' (acumulado)' }];
  for (let t = 1; t <= trimActual; t++) periodos.push({ valor: 'T' + t, etiqueta: 'Trimestre ' + t + ' de ' + anio });
  const periodo = periodos.some(x => x.valor === req.query.periodo) ? req.query.periodo : 'actual';
  const t = periodo === 'actual' ? 0 : Number(periodo.slice(1));
  const hasta = t ? fin(t) : hoy.toISOString().slice(0, 10), desde = t ? inicio(t) : anio + '-01-01';

  const aprobado = limite => Object.fromEntries(db.prepare(
    "SELECT codigo_producto AS cod, SUM(avance_reportado) AS total FROM cumplimientos WHERE estado_revision='Aprobado' AND fecha_registro <= ? GROUP BY codigo_producto")
    .all(limite).map(r => [r.cod, r.total]));
  const r1 = n => Math.round(n * 10) / 10;
  const promedio = (lista, prog) => {   // promedio del % de cada indicador (tope 100) sobre su meta del cuatrienio
    const v = lista.filter(m => m.meta > 0).map(m => Math.min(100, (prog[m.cod] || 0) / m.meta * 100));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const estadoDe = v => v >= 70 ? 'Al día' : v >= 30 ? 'En curso' : 'En riesgo';
  const prog = aprobado(hasta);

  const porSector = sectores.filter(sc => !sector || sc === sector).map(sc => {
    const lista = metas.filter(m => m.sector === sc), cumplimiento = r1(promedio(lista, prog));
    return { sector: sc, cumplimiento, estado: estadoDe(cumplimiento), indicadores: lista.length,
             administradores: [...new Set(lista.map(m => m.admin))], gestores: [...new Set(lista.map(m => m.gestor))] };
  }).sort((a, b) => b.cumplimiento - a.cumplimiento);

  // Estado de los reportes enviados dentro del periodo (sin borradores)
  const reportes = { total: 0, aprobados: 0, pendientes: 0, devueltos: 0 };
  if (metas.length) {
    db.prepare("SELECT estado_revision AS e, COUNT(*) AS n FROM cumplimientos WHERE estado_revision <> 'Borrador' AND fecha_registro BETWEEN ? AND ? AND codigo_producto IN ("
      + metas.map(() => '?').join(',') + ') GROUP BY estado_revision').all(desde, hasta, ...metas.map(m => m.cod))
      .forEach(r => { reportes.total += r.n; const k = { Aprobado: 'aprobados', Pendiente: 'pendientes', Devuelto: 'devueltos' }[r.e]; if (k) reportes[k] = r.n; });
  }

  const evolucion = [1, 2, 3, 4].map(q => ({ etiqueta: 'T' + q, actual: q === trimActual,
    valor: q <= trimActual && metas.length ? r1(promedio(metas, aprobado(fin(q)))) : null }));

  res.json({
    sesion: admin ? 'admin' : 'gestor', rol, nombre: (admin || gestor).nombre, vista: rol + ' · ' + ambito,
    periodos, periodo, sectores, sector,
    kpi: { general: r1(promedio(metas, prog)), indicadores: metas.length, sectoresActivos: porSector.length, sectoresRiesgo: porSector.filter(x => x.estado === 'En riesgo').length },
    porSector, reportes, evolucion
  });
});

/* =====================================================================
   REPORTES DE INFORMES POR GESTOR (reportes-informes.html)
   Superadministrador: todos los gestores · Administrador: los gestores a su cargo ·
   Gestor líder: los gestores con metas en los sectores de sus propias metas.
   El avance sale de los reportes APROBADOS sobre la meta del cuatrienio de cada indicador.
   ===================================================================== */
function construirInforme(req, res) {
  const admin = adminDeSesion(req), gestor = admin ? null : gestorDeSesion(req);
  if (!admin && !gestor) { res.status(401).json({ error: 'Debes iniciar sesión' }); return null; }
  const rol = admin ? admin.rol : gestor.rol;
  if (gestor && gestor.rol !== 'Gestor líder') {
    res.status(403).json({ error: 'Este informe es solo para administradores y gestores líder', rol, nombre: gestor.nombre });
    return null;
  }
  const per = PERIODOS.includes(req.query.periodicidad) ? req.query.periodicidad : '';
  let cond = '1=1', args = [], ambito = 'Todos los sectores';
  if (admin && admin.rol !== 'Superadministrador') { cond = 'g.administrador_id = ?'; args = [admin.id]; ambito = 'Sectores a su cargo'; }
  if (gestor) ambito = 'Sus sectores asignados';

  let gestores = db.prepare("SELECT g.id_gestor AS id, g.nombre FROM gestores g WHERE g.estado='Activo' AND " + cond + ' ORDER BY g.nombre').all(...args);
  let asig = db.prepare(`
    SELECT a.gestor_id AS gid, pr.codigo_producto AS cod, pr.codigo_indicador_producto AS codind, pr.nombre_producto AS producto,
           COALESCE(NULLIF(TRIM(pr.meta_redactada), ''), pr.nombre_producto) AS meta, pr.meta_cuatrienio AS metaCuatrienio,
           COALESCE(NULLIF(TRIM(pg.sector), ''), 'Sin sector') AS sector
    FROM asignaciones a
    JOIN productos pr ON pr.codigo_producto = a.codigo_producto
    JOIN programas pg ON pg.codigo_programa = pr.codigo_programa`).all();

  if (gestor) {   // un gestor líder ve los sectores de sus propias metas
    const mios = new Set(asig.filter(a => a.gid === gestor.id).map(a => a.sector));
    asig = asig.filter(a => mios.has(a.sector));
    const conMetas = new Set(asig.map(a => a.gid));
    gestores = gestores.filter(g => g.id === gestor.id || conMetas.has(g.id));
  }
  const visibles = new Set(gestores.map(g => g.id));
  asig = asig.filter(a => visibles.has(a.gid));
  const sectores = [...new Set(asig.map(a => a.sector))].sort((a, b) => a.localeCompare(b, 'es'));
  const sector = sectores.includes(req.query.sector) ? req.query.sector : '';
  if (sector) {
    asig = asig.filter(a => a.sector === sector);
    const con = new Set(asig.map(a => a.gid));
    gestores = gestores.filter(g => con.has(g.id));
  }

  // Reportes enviados (sin borradores) por indicador y estado; el filtro de periodicidad aplica a todo
  const cumPor = {};
  db.prepare("SELECT codigo_producto AS cod, estado_revision AS e, SUM(avance_reportado) AS av, COUNT(*) AS n, MAX(fecha_registro) AS ult FROM cumplimientos WHERE estado_revision <> 'Borrador'"
    + (per ? ' AND periodo = ?' : '') + ' GROUP BY codigo_producto, estado_revision').all(...(per ? [per] : []))
    .forEach(r => (cumPor[r.cod] ||= {})[r.e] = r);
  const r1 = n => Math.round(n * 10) / 10;
  const resumen = a => {
    const r = cumPor[a.cod] || {}, ap = r.Aprobado || { av: 0, n: 0 };
    return { aprobados: ap.n, pendientes: (r.Pendiente || { n: 0 }).n, devueltos: (r.Devuelto || { n: 0 }).n, avanceAprobado: ap.av,
             porcentaje: a.metaCuatrienio > 0 ? r1(Math.min(100, ap.av / a.metaCuatrienio * 100)) : null,
             ultimo: ['Aprobado', 'Pendiente', 'Devuelto'].map(e => r[e] && r[e].ult).filter(Boolean).sort().pop() || null };
  };
  return { rol, nombre: (admin || gestor).nombre, vista: rol + ' · ' + ambito, sectores, sector, gestores, asig, resumen };
}

app.get('/api/reportes/gestores', (req, res) => {
  const c = construirInforme(req, res);
  if (!c) return;
  const gestores = c.gestores.map(g => {
    const mis = c.asig.filter(a => a.gid === g.id).map(a => ({ ...a, ...c.resumen(a) }));
    const con = mis.filter(i => i.porcentaje !== null);
    const pendientes = mis.reduce((t, i) => t + i.pendientes, 0), devueltos = mis.reduce((t, i) => t + i.devueltos, 0);
    return { id: g.id, nombre: g.nombre, sectores: [...new Set(mis.map(i => i.sector))], indicadores: mis.length,
      avance: con.length ? Math.round(con.reduce((t, i) => t + i.porcentaje, 0) / con.length) : 0,
      estado: !mis.length ? 'Sin asignaciones' : devueltos ? 'Con pendientes' : pendientes ? 'En revisión' : 'Al día',
      pendientes, devueltos, ultimo: mis.map(i => i.ultimo).filter(Boolean).sort().pop() || null };
  });
  res.json({ rol: c.rol, nombre: c.nombre, vista: c.vista, sectores: c.sectores, sector: c.sector, gestores });
});

// Detalle de un gestor (lo que exporta el botón «Exportar» de cada fila)
app.get('/api/reportes/gestores/:id', (req, res) => {
  req.query.sector = '';
  const c = construirInforme(req, res);
  if (!c) return;
  const g = c.gestores.find(x => String(x.id) === req.params.id);
  if (!g) return res.status(404).json({ error: 'Gestor no encontrado o fuera de tu alcance' });
  res.json({ gestor: { id: g.id, nombre: g.nombre },
    indicadores: c.asig.filter(a => a.gid === g.id).map(a => {
      const r = c.resumen(a);
      return { codind: a.codind, producto: a.producto, meta: a.meta, sector: a.sector, metaCuatrienio: a.metaCuatrienio, ...r };
    }) });
});

/* =====================================================================
   INFORME GENERAL DE CUMPLIMIENTO (informe-general.html)
   Mismo alcance y misma fórmula del tablero general: avances APROBADOS sobre la meta del cuatrienio.
   Superadministrador: todos los sectores · Administrador: los de los gestores a su cargo ·
   Gestor / gestor líder: los de sus propias metas asignadas.
   Por cada indicador de producto devuelve lo que lleva el informe (Word y PDF): avance acumulado y de la
   vigencia, % y estado, población beneficiada, logros, evidencias y evolución por trimestre.
   El nombre y el logo de la alcaldía salen de «Marca institucional» (tabla logos).
   ===================================================================== */
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ORDINAL_TRIM = ['Primer', 'Segundo', 'Tercer', 'Cuarto'];
const FIN_TRIM = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
const textoFecha = iso => { const [y, m, d] = iso.split('-').map(Number); return d + ' de ' + MESES_ES[m - 1] + ' de ' + y; };

function alcanceInforme(req, res) {
  const admin = adminDeSesion(req), gestor = admin ? null : gestorDeSesion(req);
  if (!admin && !gestor) { res.status(401).json({ error: 'Debes iniciar sesión' }); return null; }
  let cond = '1=1', args = [], ambito = 'Todos los sectores';
  if (admin && admin.rol !== 'Superadministrador') { cond = 'g.administrador_id = ?'; args = [admin.id]; ambito = 'Sectores a su cargo'; }
  if (gestor) { cond = 'g.id_gestor = ?'; args = [gestor.id]; ambito = 'Sus sectores asignados'; }
  return { cond, args, ambito, rol: admin ? admin.rol : gestor.rol, nombre: (admin || gestor).nombre, sesion: admin ? 'admin' : 'gestor' };
}

// «150 familias» → { n: 150, unidad: 'familias' } · «1.200 personas» → { n: 1200, unidad: 'personas' }
function leerPoblacion(txt) {
  const t = String(txt ?? ''), m = t.match(/\d{1,3}(?:\.\d{3})+|\d+/);
  if (!m) return null;
  const unidad = t.slice(m.index + m[0].length).replace(/^[\s:;,.\-–]+/, '').trim().toLowerCase();
  return { n: Number(m[0].replace(/\./g, '')), unidad: unidad || 'personas' };
}

app.get('/api/informe', (req, res) => {
  const ctx = alcanceInforme(req, res);
  if (!ctx) return;

  const p2 = n => String(n).padStart(2, '0'), r1 = n => Math.round(n * 10) / 10;
  const estadoDe = v => v >= 70 ? 'Al día' : v >= 30 ? 'En curso' : 'En riesgo';
  const hoy = new Date(), anioHoy = hoy.getFullYear(), trimHoy = Math.floor(hoy.getMonth() / 3) + 1;
  const hoyIso = anioHoy + '-' + p2(hoy.getMonth() + 1) + '-' + p2(hoy.getDate());

  // Metas (indicadores de producto) asignadas dentro del alcance, con su programa, sector y línea
  const todas = db.prepare(`
    SELECT pr.codigo_producto AS cod, pr.codigo_indicador_producto AS codind, pr.nombre_producto AS producto,
           pr.indicador_producto AS indicador, pr.meta_redactada AS metaTxt, pr.linea_base AS lineaBase, pr.meta_cuatrienio AS meta,
           pg.codigo_programa AS prog, pg.nombre_programa AS progNombre, COALESCE(NULLIF(TRIM(pg.sector), ''), 'Sin sector') AS sector,
           le.id AS lineaId, le.numero_linea_estrategica AS lineaNum, le.nombre_linea AS lineaNombre
    FROM asignaciones a
    JOIN gestores g ON g.id_gestor = a.gestor_id
    JOIN productos pr ON pr.codigo_producto = a.codigo_producto
    JOIN programas pg ON pg.codigo_programa = pr.codigo_programa
    JOIN lineas_estrategicas le ON le.id = pg.linea_id
    WHERE ` + ctx.cond + ' ORDER BY le.numero_linea_estrategica, pg.codigo_programa, pr.codigo_indicador_producto').all(...ctx.args);

  // Año evaluado, corte (acumulado o trimestre) y fecha límite de los avances que cuentan
  const anios = [...new Set([anioHoy, ...db.prepare("SELECT DISTINCT CAST(substr(fecha_registro, 1, 4) AS INTEGER) AS a FROM cumplimientos WHERE estado_revision = 'Aprobado'").all().map(r => r.a)])]
    .filter(a => a > 2000).sort((a, b) => a - b);
  const anio = anios.includes(Number(req.query.anio)) ? Number(req.query.anio) : anioHoy;
  const maxT = anio < anioHoy ? 4 : anio === anioHoy ? trimHoy : 0;            // trimestres ya iniciados
  const periodos = [{ valor: 'acumulado', etiqueta: 'Año ' + anio + ' (acumulado)' }];
  for (let t = 1; t <= maxT; t++) periodos.push({ valor: String(t), etiqueta: 'Trimestre ' + t + ' de ' + anio });
  const periodo = periodos.some(x => x.valor === req.query.periodo) ? req.query.periodo : 'acumulado';
  const t = periodo === 'acumulado' ? 0 : Number(periodo);
  const hasta = t ? anio + '-' + FIN_TRIM[t] : anio < anioHoy ? anio + '-12-31' : anio === anioHoy ? hoyIso : anio + '-01-01';
  const fechaCorte = hasta > hoyIso ? hoyIso : hasta;
  const qMax = t || maxT;

  // Filtros de línea estratégica y de programa (solo las que tienen indicadores dentro del alcance)
  const lineas = [];
  todas.forEach(m => { if (!lineas.some(l => l.id === m.lineaId)) lineas.push({ id: m.lineaId, numero: m.lineaNum, nombre: m.lineaNombre }); });
  const linea = lineas.some(l => String(l.id) === String(req.query.linea)) ? Number(req.query.linea) : '';
  const delaLinea = linea ? todas.filter(m => m.lineaId === linea) : todas;
  const programas = [];
  delaLinea.forEach(m => { if (!programas.some(p => p.codigo === m.prog)) programas.push({ codigo: m.prog, nombre: m.progNombre, lineaId: m.lineaId, sector: m.sector }); });
  const programa = programas.some(p => p.codigo === req.query.programa) ? req.query.programa : '';
  const metas = programa ? delaLinea.filter(m => m.prog === programa) : delaLinea;

  // Avances aprobados hasta la fecha de corte (todos los años: la meta es del cuatrienio), con evidencias
  const regs = {};
  const ids = {};
  db.prepare(`SELECT id_cumplimiento AS id, codigo_producto AS cod, avance_reportado AS av, fecha_registro AS fecha,
                     logro_alcanzado AS logro, poblacion_beneficiada AS pob
              FROM cumplimientos WHERE estado_revision = 'Aprobado' AND fecha_registro <= ? ORDER BY fecha_registro, id_cumplimiento`)
    .all(hasta).forEach(r => { (regs[r.cod] ||= []).push({ ...r, evid: [] }); ids[r.id] = regs[r.cod][regs[r.cod].length - 1]; });
  db.prepare(`SELECT e.id_evidencia AS id, e.id_cumplimiento AS cid, e.nombre_archivo AS nombre, e.tipo, e.tamano
              FROM evidencias e JOIN cumplimientos c ON c.id_cumplimiento = e.id_cumplimiento
              WHERE c.estado_revision = 'Aprobado' AND c.fecha_registro <= ? ORDER BY e.id_evidencia`)
    .all(hasta).forEach(e => { if (ids[e.cid]) ids[e.cid].evid.push(e); });

  const suma = (lista, limite, desde) => lista.filter(r => r.fecha <= limite && (!desde || r.fecha >= desde)).reduce((s, r) => s + (r.av || 0), 0);
  const pctDe = (m, v) => m.meta > 0 ? Math.min(100, v / m.meta * 100) : 0;
  const promedio = lista => lista.length ? lista.reduce((s, x) => s + x, 0) / lista.length : 0;

  const indicadores = metas.map(m => {
    const lista = regs[m.cod] || [], acumulado = suma(lista, hasta), vigencia = suma(lista, hasta, anio + '-01-01');
    const porcentaje = r1(pctDe(m, acumulado));
    const pobs = lista.map(r => leerPoblacion(r.pob)).filter(Boolean);
    const evidencias = [];
    [...lista].reverse().forEach(r => r.evid.forEach(e => evidencias.push({ id: e.id, nombre: e.nombre, tipo: e.tipo, tamano: e.tamano, fecha: r.fecha })));
    return {
      codProducto: m.cod, codigo: m.codind, producto: m.producto, indicador: m.indicador, metaRedactada: m.metaTxt,
      lineaBase: m.lineaBase, metaCuatrienio: m.meta, evaluable: m.meta > 0,
      programa: m.prog, programaNombre: m.progNombre, sector: m.sector, lineaId: m.lineaId, lineaNumero: m.lineaNum, lineaNombre: m.lineaNombre,
      acumulado, vigencia, porcentaje, estado: estadoDe(porcentaje), reportes: lista.length,
      poblacion: { personas: pobs.reduce((s, p) => s + p.n, 0), unidad: [...new Set(pobs.map(p => p.unidad))].join(', ') },
      logros: [...new Map(lista.filter(r => String(r.logro || '').trim()).map(r => [String(r.logro).trim(), { texto: String(r.logro).trim(), fecha: r.fecha }])).values()],
      evidencias,
      evolucion: Array.from({ length: qMax }, (_, i) => r1(pctDe(m, suma(lista, anio + '-' + FIN_TRIM[i + 1]))))
    };
  });

  const evaluables = indicadores.filter(i => i.evaluable);
  const promedioPct = (lista, q) => lista.length ? r1(promedio(lista.map(i => q === undefined ? Math.min(100, i.acumulado / i.metaCuatrienio * 100) : i.evolucion[q]))) : 0;
  const porGrupo = (clave, extra) => [...new Set(indicadores.map(i => i[clave]))].map(k => {
    const lst = indicadores.filter(i => i[clave] === k), ev = lst.filter(i => i.evaluable), cumplimiento = promedioPct(ev);
    return { ...extra(lst[0]), cumplimiento, estado: estadoDe(cumplimiento), indicadores: lst.length };
  });
  const general = promedioPct(evaluables);

  const entidad = db.prepare(`SELECT id, nombre_entidad AS nombre, (logo IS NOT NULL) AS tieneLogo, COALESCE(logo_actualizado, '') AS version
                              FROM logos ORDER BY id LIMIT 1`).get();

  res.json({
    sesion: ctx.sesion, rol: ctx.rol, nombre: ctx.nombre, vista: ctx.rol + ' · ' + ctx.ambito,
    entidad: entidad ? { id: entidad.id, nombre: entidad.nombre, tieneLogo: !!entidad.tieneLogo, version: entidad.version } : null,
    plan: 'Plan de Desarrollo Municipal',
    anios, anio, periodos, periodo, lineas, linea, programas, programa,
    corte: {
      trimestre: t, hasta, fecha: fechaCorte, fechaTexto: textoFecha(fechaCorte),
      etiqueta: periodos.find(x => x.valor === periodo).etiqueta,
      texto: t ? ORDINAL_TRIM[t - 1] + ' trimestre de ' + anio : 'Acumulado del año ' + anio + ' (a ' + textoFecha(fechaCorte) + ')',
      trimestres: Array.from({ length: qMax }, (_, i) => i + 1)
    },
    kpi: {
      general, indicadores: indicadores.length,
      personas: indicadores.reduce((s, i) => s + i.poblacion.personas, 0),
      enRiesgo: indicadores.filter(i => i.evaluable && i.estado === 'En riesgo').length,
      evolucion: Array.from({ length: qMax }, (_, q) => promedioPct(evaluables, q))
    },
    porLinea: porGrupo('lineaId', i => ({ id: i.lineaId, numero: i.lineaNumero, nombre: i.lineaNombre })),
    porPrograma: porGrupo('programa', i => ({ codigo: i.programa, nombre: i.programaNombre, sector: i.sector, lineaId: i.lineaId })),
    indicadores
  });
});

// Imagen de evidencia (solo de avances aprobados y dentro del alcance de quien consulta): la usan el Word y el PDF
app.get('/api/informe/evidencias/:id', (req, res) => {
  const ctx = alcanceInforme(req, res);
  if (!ctx) return;
  const e = db.prepare(`
    SELECT e.archivo, e.tipo FROM evidencias e
    JOIN cumplimientos c ON c.id_cumplimiento = e.id_cumplimiento
    JOIN asignaciones a ON a.codigo_producto = c.codigo_producto
    JOIN gestores g ON g.id_gestor = a.gestor_id
    WHERE e.id_evidencia = ? AND c.estado_revision = 'Aprobado' AND ` + ctx.cond).get(Number(req.params.id), ...ctx.args);
  if (!e) return res.status(404).json({ error: 'Evidencia no encontrada o fuera de tu alcance' });
  res.setHeader('Content-Type', e.tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(Buffer.from(e.archivo));
});

/* =====================================================================
   COPIAS DE SEGURIDAD (copias-de-seguridad.html) · solo Superadministrador
   - Exportar: crea una copia consistente de sisr.db (VACUUM INTO), la guarda en la carpeta «respaldos»
     y la descarga.
   - Importar / Restaurar: valida el archivo, guarda ANTES una copia «previa» de la base vigente y
     reemplaza los datos en una sola transacción (si algo falla, no se cambia nada).
   - Copias automáticas: según la programación guardada en la tabla ajustes (claves respaldo_*).
   ===================================================================== */
const fs = require('fs');
const DIR_RESPALDOS = path.resolve('respaldos');
const ARCHIVO_BD = path.resolve('sisr.db');
const MAX_IMPORTACION = 100 * 1024 * 1024;           // 100 MB
fs.mkdirSync(DIR_RESPALDOS, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS copias_respaldo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('manual','automatica','previa')),
    archivo TEXT NOT NULL,
    tamano INTEGER NOT NULL DEFAULT 0,
    estado TEXT NOT NULL CHECK (estado IN ('completada','error')),
    creado_por TEXT NOT NULL DEFAULT '',
    detalle TEXT NOT NULL DEFAULT ''
  )`);

class ErrRespaldo extends Error {}                     // errores que se le explican al usuario
let respaldoOcupado = false;                           // una sola copia/restauración a la vez

const pad2 = n => String(n).padStart(2, '0');
const ahoraLocal = (d = new Date()) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
const aFecha = s => new Date(String(s).replace(' ', 'T'));
const rutaDe = nombre => path.join(DIR_RESPALDOS, path.basename(String(nombre)));
const borrarArchivo = nombre => { try { fs.unlinkSync(rutaDe(nombre)); } catch (e) { /* ya no existía */ } };

/* ---------- programación ---------- */
const CFG_DEF = { respaldo_activo: '1', respaldo_frecuencia: 'semanal', respaldo_dia: '6', respaldo_hora: '02:00', respaldo_retencion: '12' };
function guardarAjuste(clave, valor) {
  db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, String(valor));
}
function leerCfg() {
  const m = { ...CFG_DEF };
  db.prepare("SELECT clave, valor FROM ajustes WHERE clave LIKE 'respaldo!_%' ESCAPE '!'").all().forEach(f => { m[f.clave] = f.valor; });
  return { activo: m.respaldo_activo === '1', frecuencia: m.respaldo_frecuencia, dia: Number(m.respaldo_dia), hora: m.respaldo_hora, retencion: Number(m.respaldo_retencion), base: m.respaldo_base || null };
}
if (!leerCfg().base) guardarAjuste('respaldo_base', ahoraLocal());       // las copias se cuentan desde que se activa el módulo

// Primera fecha posterior a «desde» que cumple la programación (semanal: día de la semana · mensual: día 1)
function proximaEjecucion(cfg, desde) {
  const [h, m] = cfg.hora.split(':').map(Number);
  for (let i = 0; i < 400; i++) {
    const c = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() + i, h, m, 0, 0);
    if (c <= desde) continue;
    if (cfg.frecuencia === 'diaria') return c;
    if (cfg.frecuencia === 'semanal' && c.getDay() === cfg.dia) return c;
    if (cfg.frecuencia === 'mensual' && c.getDate() === 1) return c;
  }
  return null;
}

/* ---------- crear una copia ---------- */
function crearCopia(tipo, usuario) {
  const prefijo = tipo === 'previa' ? 'sisr_previa_' : 'sisr_respaldo_';
  const sello = () => ahoraLocal().replace(' ', '_').replace(/:/g, '');
  let nombre = prefijo + sello() + '.db', n = 1;
  while (fs.existsSync(rutaDe(nombre))) nombre = prefijo + sello() + '_' + (++n) + '.db';
  const ruta = rutaDe(nombre), fecha = ahoraLocal();
  try {
    db.exec("VACUUM INTO '" + ruta.replace(/'/g, "''") + "'");
    const tamano = fs.statSync(ruta).size;
    const id = db.prepare("INSERT INTO copias_respaldo (fecha, tipo, archivo, tamano, estado, creado_por) VALUES (?, ?, ?, ?, 'completada', ?)")
      .run(fecha, tipo, nombre, tamano, usuario).lastInsertRowid;
    return { id: Number(id), archivo: nombre, ruta, tamano, fecha };
  } catch (e) {
    try { fs.unlinkSync(ruta); } catch (_) { /* no se llegó a crear */ }
    db.prepare("INSERT INTO copias_respaldo (fecha, tipo, archivo, tamano, estado, creado_por, detalle) VALUES (?, ?, ?, 0, 'error', ?, ?)")
      .run(fecha, tipo, nombre, usuario, String(e.message || e).slice(0, 300));
    throw e;
  }
}
function aplicarRetencion(maximo) {          // solo las automáticas: las manuales y las previas nunca se borran solas
  db.prepare("SELECT id, archivo FROM copias_respaldo WHERE tipo = 'automatica' ORDER BY id DESC LIMIT -1 OFFSET ?").all(maximo)
    .forEach(f => { borrarArchivo(f.archivo); db.prepare('DELETE FROM copias_respaldo WHERE id = ?').run(f.id); });
}

/* ---------- validar y aplicar un archivo de respaldo ---------- */
const tablasDelSistema = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND name != 'copias_respaldo'").all().map(t => t.name);
const columnasDe = (conexion, tabla) => conexion.prepare('PRAGMA table_info("' + tabla + '")').all().map(c => c.name);

function validarBD(ruta) {
  const fd = fs.openSync(ruta, 'r'), cab = Buffer.alloc(16);
  fs.readSync(fd, cab, 0, 16, 0); fs.closeSync(fd);
  if (cab.toString('latin1') !== 'SQLite format 3\u0000') throw new ErrRespaldo('El archivo no es una base de datos SQLite. Selecciona un archivo de respaldo .db generado por el sistema.');
  let o;
  try {
    o = new Database(ruta, { readonly: true });
    const chk = o.prepare('PRAGMA quick_check').all();
    if (!(chk.length === 1 && Object.values(chk[0])[0] === 'ok')) throw new ErrRespaldo('El archivo de respaldo está dañado y no se puede restaurar.');
    const existentes = o.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    tablasDelSistema().forEach(t => {
      if (!existentes.includes(t)) throw new ErrRespaldo('El archivo no corresponde a este sistema: le falta la tabla «' + t + '».');
      const cols = columnasDe(o, t), faltan = columnasDe(db, t).filter(c => !cols.includes(c));
      if (faltan.length) throw new ErrRespaldo('El respaldo es de una versión anterior del sistema (a la tabla «' + t + '» le falta: ' + faltan.join(', ') + ').');
    });
    if (o.prepare("SELECT COUNT(*) c FROM administradores WHERE rol = 'Superadministrador' AND estado = 'Activo'").get().c < 1)
      throw new ErrRespaldo('El respaldo no tiene ningún Superadministrador activo; al restaurarlo nadie podría administrar el sistema.');
  } catch (e) {
    if (e instanceof ErrRespaldo) throw e;
    throw new ErrRespaldo('No se pudo leer el archivo como una base de datos del sistema.');
  } finally { if (o) o.close(); }
}

// Reemplaza los datos en UNA transacción. Se conservan el secreto de sesión (para no cerrar sesiones), la
// programación de copias y el historial de copias, que pertenecen a este servidor y no al respaldo.
function aplicarCopia(ruta) {
  const tablas = tablasDelSistema();
  db.exec("ATTACH DATABASE '" + ruta.replace(/'/g, "''") + "' AS imp");
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      tablas.forEach(t => {
        const cols = columnasDe(db, t).map(c => '"' + c + '"').join(', ');
        const filtro = t === 'ajustes' ? " WHERE clave != 'secreto_sesion' AND clave NOT LIKE 'respaldo!_%' ESCAPE '!'" : '';
        db.exec('DELETE FROM main."' + t + '"' + filtro);
        db.exec('INSERT INTO main."' + t + '" (' + cols + ') SELECT ' + cols + ' FROM imp."' + t + '"' + filtro);
      });
      db.exec("DELETE FROM main.sqlite_sequence WHERE name != 'copias_respaldo'");
      if (db.prepare("SELECT 1 FROM imp.sqlite_master WHERE name = 'sqlite_sequence'").get())
        db.exec("INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM imp.sqlite_sequence WHERE name != 'copias_respaldo'");
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally {
    db.pragma('foreign_keys = ON');
    db.exec('DETACH DATABASE imp');
  }
}

// Validar → guardar copia «previa» de la base vigente → aplicar
function restaurar(ruta, usuario) {
  validarBD(ruta);
  const previa = crearCopia('previa', usuario);
  aplicarCopia(ruta);
  return { previa: previa.archivo };
}

/* Ejecuta una operación exclusiva y traduce los errores a respuestas JSON claras */
function operacionRespaldo(res, mensajeError, fn) {
  if (respaldoOcupado) return res.status(409).json({ error: 'Hay otra copia o restauración en curso. Espera unos segundos e inténtalo de nuevo.' });
  respaldoOcupado = true;
  try { return fn(); }
  catch (e) {
    if (e instanceof ErrRespaldo) return res.status(400).json({ error: e.message });
    if (e && (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED')) throw e;
    console.error(e);
    return res.status(500).json({ error: mensajeError + ': ' + String(e.message || e).slice(0, 200) });
  } finally { respaldoOcupado = false; }
}
function enviarArchivo(res, nombre) {
  const ruta = rutaDe(nombre);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(nombre) + '"');
  res.setHeader('Content-Length', fs.statSync(ruta).size);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(ruta).pipe(res);
}

function requiereSuper(req, res, next) {
  requiereSesion(req, res, () => {
    if (req.admin.rol !== 'Superadministrador') return res.status(403).json({ error: 'Solo el Superadministrador puede gestionar las copias de seguridad' });
    next();
  });
}

/* ---------- servicios ---------- */
function estadoRespaldo(req) {
  const cfg = leerCfg();
  const todas = db.prepare('SELECT id, fecha, tipo, archivo, tamano, estado, creado_por AS creadoPor, detalle FROM copias_respaldo ORDER BY id DESC').all()
    .map(h => ({ ...h, disponible: h.estado === 'completada' && fs.existsSync(rutaDe(h.archivo)) }));
  const prox = cfg.activo && cfg.base ? proximaEjecucion(cfg, aFecha(cfg.base)) : null;
  return {
    rol: req.admin.rol, nombre: req.admin.nombre, carpeta: DIR_RESPALDOS,
    config: { activo: cfg.activo, frecuencia: cfg.frecuencia, dia: cfg.dia, hora: cfg.hora, retencion: cfg.retencion },
    proxima: prox ? ahoraLocal(prox) : null,
    ultima: todas.find(h => h.disponible) || null,
    total: todas.filter(h => h.disponible).length,
    tamanoBD: fs.statSync(ARCHIVO_BD).size,
    ahora: ahoraLocal(),
    historial: todas.slice(0, 50)
  };
}
app.get('/api/respaldo', requiereSuper, (req, res) => res.json(estadoRespaldo(req)));

app.post('/api/respaldo/exportar', requiereSuper, (req, res) => operacionRespaldo(res, 'No se pudo crear la copia', () => {
  const c = crearCopia('manual', req.admin.nombre);
  res.setHeader('X-Respaldo-Id', String(c.id));
  enviarArchivo(res, c.archivo);
}));

app.get('/api/respaldo/:id/descargar', requiereSuper, (req, res) => {
  const h = db.prepare("SELECT archivo FROM copias_respaldo WHERE id = ? AND estado = 'completada'").get(Number(req.params.id));
  if (!h || !fs.existsSync(rutaDe(h.archivo))) return res.status(404).json({ error: 'El archivo de esa copia ya no está en el servidor' });
  enviarArchivo(res, h.archivo);
});

app.delete('/api/respaldo/:id', requiereSuper, (req, res) => operacionRespaldo(res, 'No se pudo eliminar la copia', () => {
  const h = db.prepare('SELECT id, archivo FROM copias_respaldo WHERE id = ?').get(Number(req.params.id));
  if (!h) return res.status(404).json({ error: 'Esa copia no existe' });
  borrarArchivo(h.archivo);
  db.prepare('DELETE FROM copias_respaldo WHERE id = ?').run(h.id);
  res.json({ ok: true });
}));

app.post('/api/respaldo/:id/restaurar', requiereSuper, (req, res) => {
  if ((req.body || {}).confirmacion !== 'RESTAURAR') return res.status(400).json({ error: 'Falta la confirmación para restaurar' });
  const h = db.prepare("SELECT archivo FROM copias_respaldo WHERE id = ? AND estado = 'completada'").get(Number(req.params.id));
  if (!h || !fs.existsSync(rutaDe(h.archivo))) return res.status(404).json({ error: 'El archivo de esa copia ya no está en el servidor' });
  operacionRespaldo(res, 'No se pudo restaurar la copia', () => {
    const r = restaurar(rutaDe(h.archivo), req.admin.nombre);
    console.log('Base de datos restaurada desde ' + h.archivo + ' por ' + req.admin.nombre);
    res.json({ ok: true, previa: r.previa });
  });
});

app.post('/api/respaldo/importar', requiereSuper, express.raw({ type: 'application/octet-stream', limit: MAX_IMPORTACION }), (req, res) => {
  if (req.headers['x-confirmacion'] !== 'RESTAURAR') return res.status(400).json({ error: 'Falta la confirmación para importar' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  operacionRespaldo(res, 'No se pudo importar la base de datos', () => {
    const tmp = path.join(DIR_RESPALDOS, '_importando_' + Date.now() + '.tmp');
    fs.writeFileSync(tmp, req.body);
    try {
      const r = restaurar(tmp, req.admin.nombre);
      console.log('Base de datos importada por ' + req.admin.nombre);
      res.json({ ok: true, previa: r.previa });
    } finally { try { fs.unlinkSync(tmp); } catch (e) { /* ya no está */ } }
  });
});

app.put('/api/respaldo/programacion', requiereSuper, (req, res) => {
  const d = req.body || {}, retencion = Number(d.retencion), dia = Number(d.dia);
  if (!['diaria', 'semanal', 'mensual'].includes(d.frecuencia)) return res.status(400).json({ error: 'Frecuencia no válida' });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.hora))) return res.status(400).json({ error: 'Hora no válida' });
  if (!Number.isInteger(dia) || dia < 0 || dia > 6) return res.status(400).json({ error: 'Día no válido' });
  if (!Number.isInteger(retencion) || retencion < 1 || retencion > 100) return res.status(400).json({ error: 'Las copias a conservar deben estar entre 1 y 100' });
  db.transaction(() => {
    guardarAjuste('respaldo_activo', d.activo ? '1' : '0');
    guardarAjuste('respaldo_frecuencia', d.frecuencia);
    guardarAjuste('respaldo_dia', dia);
    guardarAjuste('respaldo_hora', d.hora);
    guardarAjuste('respaldo_retencion', retencion);
    guardarAjuste('respaldo_base', ahoraLocal());            // la próxima copia se calcula desde este momento
  })();
  res.json(estadoRespaldo(req));
});

/* ---------- copias automáticas: se revisa cada minuto (y se recupera una copia pendiente si el servidor estuvo apagado) ---------- */
function revisarCopiaAutomatica() {
  try {
    if (respaldoOcupado) return;
    const cfg = leerCfg();
    if (!cfg.activo || !cfg.base) return;
    const prox = proximaEjecucion(cfg, aFecha(cfg.base));
    if (!prox || new Date() < prox) return;
    respaldoOcupado = true;
    try {
      guardarAjuste('respaldo_base', ahoraLocal());
      crearCopia('automatica', 'Automática');
      aplicarRetencion(cfg.retencion);
      console.log('Copia automática creada');
    } catch (e) { console.error('La copia automática falló:', e.message); }
    finally { respaldoOcupado = false; }
  } catch (e) { console.error(e); }
}
setTimeout(revisarCopiaAutomatica, 10000).unref();
setInterval(revisarCopiaAutomatica, 60000).unref();

// Errores no controlados: siempre se responde en JSON para que la página pueda mostrarlos
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large')
    return res.status(413).json({ error: req.path.startsWith('/api/respaldo') ? 'El archivo supera el máximo de 100 MB' : 'La imagen supera el máximo de 2 MB' });
  // Otro programa (DB Browser, OneDrive, un segundo servidor...) tiene bloqueado sisr.db
  if (err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED')) {
    console.error('Base de datos ocupada: otro programa tiene abierto sisr.db');
    return res.status(503).json({ error: 'La base de datos está ocupada por otro programa. Cierra los programas que tengan abierto sisr.db (por ejemplo DB Browser for SQLite) e inténtalo de nuevo.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Error del servidor' });
});

// Al arrancar, se muestra qué archivo de base de datos se está usando y qué tablas tiene
const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name);
console.log('Base de datos: ' + path.resolve('sisr.db'));
console.log('Tablas (' + tablas.length + '): ' + tablas.join(', '));

app.listen(3000, () => console.log('Servidor listo en http://localhost:3000'));
