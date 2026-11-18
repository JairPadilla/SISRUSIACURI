/* =====================================================================
   Gestores: inicio de sesión, sesión y estado de cumplimientos
   Se conecta desde server.js con una sola línea (ver instrucciones).
   ===================================================================== */

const express = require('express');

module.exports = function (app, db, { firmar, leerCookie, verificarPassword, MAX_INTENTOS }) {
  const COOKIE = 'sisr_gestor';
  const DURACION_S = 8 * 60 * 60;
  const DURACION_RECORDAR_S = 30 * 24 * 60 * 60;

  // Los tokens de gestor se firman con un prefijo distinto: un token de gestor
  // nunca sirve como sesión de administrador, ni al revés.
  function crearToken(id, segundos) {
    const cuerpo = Buffer.from(JSON.stringify({ id, exp: Math.floor(Date.now() / 1000) + segundos })).toString('base64url');
    return cuerpo + '.' + firmar('gestor:' + cuerpo);
  }

  function leerToken(token) {
    const [cuerpo, firma] = String(token || '').split('.');
    if (!cuerpo || !firma) return null;
    const esperada = Buffer.from(firmar('gestor:' + cuerpo));
    const recibida = Buffer.from(firma);
    if (esperada.length !== recibida.length || !require('crypto').timingSafeEqual(esperada, recibida)) return null;
    try {
      const d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
      return d.exp > Date.now() / 1000 ? d : null;
    } catch (e) { return null; }
  }

  function ponerCookie(res, valor, segundos) {
    res.setHeader('Set-Cookie', COOKIE + '=' + valor + '; HttpOnly; SameSite=Lax; Path=/' + (segundos === null ? '' : '; Max-Age=' + segundos));
  }

  function gestorDeSesion(req) {
    const d = leerToken(leerCookie(req, COOKIE));
    if (!d) return null;
    return db.prepare("SELECT id_gestor AS id, nombre, cargo, email, rol FROM gestores WHERE id_gestor=? AND estado='Activo'").get(d.id) || null;
  }

  function requiereGestor(req, res, next) {
    const g = gestorDeSesion(req);
    if (!g) return res.status(401).json({ error: 'Debes iniciar sesión' });
    req.gestor = g;
    next();
  }

  // Lo llama /api/login cuando el correo no es de un administrador.
  // Devuelve false si el correo tampoco es de un gestor (para que siga el error genérico).
  function loginGestor(req, res, b) {
    const email = String(b.email ?? '').trim();
    const password = String(b.password ?? '');
    const g = email && password
      ? db.prepare('SELECT id_gestor, nombre, password_hash, estado, intentos_fallidos FROM gestores WHERE email=?').get(email)
      : null;
    if (!g) return false;

    if (g.estado === 'Bloqueado')
      return res.status(403).json({ error: 'Tu cuenta está bloqueada. Pide a tu administrador que la active' }), true;

    if (!verificarPassword(password, g.password_hash)) {
      if (g.estado === 'Activo') {
        const n = g.intentos_fallidos + 1;
        const bloquear = n >= MAX_INTENTOS;
        db.prepare('UPDATE gestores SET intentos_fallidos=?, estado=? WHERE id_gestor=?').run(n, bloquear ? 'Bloqueado' : 'Activo', g.id_gestor);
        if (bloquear)
          return res.status(403).json({ error: 'Superaste ' + MAX_INTENTOS + ' intentos. Tu cuenta quedó bloqueada; pide a tu administrador que la active' }), true;
      }
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' }), true;
    }
    if (g.estado !== 'Activo')
      return res.status(403).json({ error: 'Tu cuenta está inactiva. Pide a tu administrador que la active' }), true;

    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    db.prepare("UPDATE gestores SET intentos_fallidos=0, ultimo_acceso=datetime('now'), ip_ultimo_acceso=? WHERE id_gestor=?").run(ip, g.id_gestor);
    const recordar = b.recordar === true;
    const dur = recordar ? DURACION_RECORDAR_S : DURACION_S;
    ponerCookie(res, crearToken(g.id_gestor, dur), recordar ? dur : null);
    res.json({ id: g.id_gestor, nombre: g.nombre, tipo: 'gestor' });
    return true;
  }

  app.get('/api/gestor/sesion', requiereGestor, (req, res) => res.json(req.gestor));

  app.post('/api/gestor/logout', (req, res) => {
    ponerCookie(res, '', 0);
    res.status(204).end();
  });

  // Solo devuelve los cumplimientos del gestor que tiene la sesión abierta
  app.get('/api/gestor/cumplimientos', requiereGestor, (req, res) => {
    res.json(db.prepare(`
      SELECT c.id_cumplimiento AS id, c.periodo AS periodicidad, c.avance_reportado AS avance,
             c.porcentaje_cumplimiento AS porcentaje, c.estado_revision AS estado,
             c.fecha_registro AS fecha, c.fecha_revision AS fechaRevision,
             pr.codigo_indicador_producto AS codind, pr.meta_redactada AS meta,
             pr.meta_cuatrienio AS metacuatrienio
      FROM cumplimientos c
      JOIN productos pr ON pr.codigo_producto = c.codigo_producto
      WHERE c.gestor_id = ?
      ORDER BY c.id_cumplimiento DESC`).all(req.gestor.id));
  });

  // Un cumplimiento del gestor con la sesión abierta (lo usa el formulario de evidencias)
  app.get('/api/gestor/cumplimientos/:id', requiereGestor, (req, res) => {
    const c = db.prepare(`
      SELECT c.id_cumplimiento AS id, c.codigo_producto AS codprod, c.periodo, c.avance_reportado AS avance,
             c.porcentaje_cumplimiento AS porcentaje, c.estado_revision AS estado, c.fecha_registro AS fecha,
             c.observacion_revision AS observacion, c.fecha_revision AS fechaRevision
      FROM cumplimientos c
      WHERE c.id_cumplimiento = ? AND c.gestor_id = ?`).get(req.params.id, req.gestor.id);
    if (!c) return res.status(404).json({ error: 'No se encontró ese cumplimiento entre los tuyos' });
    c.evidencias = db.prepare('SELECT id_evidencia AS id, nombre_archivo AS nombre, tamano FROM evidencias WHERE id_cumplimiento=? ORDER BY id_evidencia').all(c.id);
    res.json(c);
  });

  /* ---------------------------------------------------------------
     Registro de avance y evidencias (formulario registro-avance-evidencia.html)
     Estados: Borrador → Pendiente (enviado) → Aprobado o Devuelto.
     Solo se puede modificar un cumplimiento propio en Borrador o Devuelto.
     --------------------------------------------------------------- */
  const MAX_ARCHIVOS = 10, MAX_BYTES = 10 * 1048576;
  const EDITABLES = ['Borrador', 'Devuelto'];
  const FIRMAS = { 'image/jpeg': [0xFF, 0xD8, 0xFF], 'image/png': [0x89, 0x50, 0x4E, 0x47], 'application/pdf': [0x25, 0x50, 0x44, 0x46] };

  // Lo ya registrado de una meta: avances enviados a revisión o aprobados
  const acumuladoDe = codprod => db.prepare(
    "SELECT COALESCE(SUM(avance_reportado),0) AS s FROM cumplimientos WHERE codigo_producto=? AND estado_revision IN ('Pendiente','Aprobado')").get(codprod).s;

  // Indicadores asignados al gestor, con lo que lleva acumulado cada meta
  app.get('/api/gestor/indicadores', requiereGestor, (req, res) => {
    const filas = db.prepare(`
      SELECT pr.codigo_producto AS codprod, pr.nombre_producto AS nomprod,
             pr.codigo_indicador_producto AS codind, pr.indicador_producto AS indprod,
             pr.meta_redactada AS metared, pr.linea_base AS lineabase,
             pr.meta_cuatrienio AS metacuatrienio, a.dependencia AS dependencia
      FROM asignaciones a
      JOIN productos pr ON pr.codigo_producto = a.codigo_producto
      WHERE a.gestor_id = ?
      ORDER BY CAST(pr.codigo_producto AS INTEGER), pr.codigo_producto`).all(req.gestor.id);
    res.json(filas.map(f => {
      const acumulado = acumuladoDe(f.codprod);
      return { ...f, acumulado, cumplida: f.metacuatrienio > 0 && acumulado >= f.metacuatrienio };
    }));
  });

  // Valida los datos del avance y calcula el porcentaje (avance acumulado ÷ meta del cuatrienio)
  function validar(b, gestor) {
    const codprod = String(b.codprod ?? '').trim();
    const periodo = String(b.periodo ?? '');
    const avance = Number(b.avance);
    if (!['Mensual', 'Trimestral'].includes(periodo)) return { status: 400, error: 'Selecciona el periodo (mensual o trimestral)' };
    if (b.avance === '' || b.avance == null || !Number.isFinite(avance) || avance < 0)
      return { status: 400, error: 'El avance reportado debe ser un número mayor o igual a 0' };
    const m = db.prepare(`
      SELECT pr.meta_cuatrienio AS meta FROM asignaciones a
      JOIN productos pr ON pr.codigo_producto = a.codigo_producto
      WHERE a.codigo_producto = ? AND a.gestor_id = ?`).get(codprod, gestor.id);
    if (!m) return { status: 403, error: 'Ese indicador no está asignado a tu usuario' };
    if (!(m.meta > 0)) return { status: 400, error: 'Este indicador no tiene meta del cuatrienio; avisa a tu administrador' };
    const acum = acumuladoDe(codprod);
    const falta = Math.round((m.meta - acum) * 1e6) / 1e6;
    if (falta <= 0) return { status: 400, error: 'La meta de este indicador ya alcanzó el 100 %' };
    if (avance > falta) return { status: 400, error: 'El avance reportado supera lo que falta para cumplir la meta (faltan ' + falta + ')' };
    return { codprod, periodo, avance, porcentaje: Math.min(100, Math.round((acum + avance) / m.meta * 1000) / 10) };
  }

  // Cumplimiento del gestor de la sesión; solo si está en Borrador o Devuelto
  function propio(req, res) {
    const c = db.prepare('SELECT id_cumplimiento AS id, gestor_id, estado_revision AS estado FROM cumplimientos WHERE id_cumplimiento=?').get(req.params.id);
    if (!c || c.gestor_id !== req.gestor.id) { res.status(404).json({ error: 'No se encontró ese cumplimiento entre los tuyos' }); return null; }
    if (!EDITABLES.includes(c.estado)) {
      res.status(409).json({ error: 'Solo se puede modificar un cumplimiento en borrador o devuelto por el gestor líder' });
      return null;
    }
    return c;
  }

  app.post('/api/cumplimientos', requiereGestor, (req, res) => {
    const v = validar(req.body || {}, req.gestor);
    if (v.error) return res.status(v.status).json({ error: v.error });
    const r = db.prepare(`INSERT INTO cumplimientos (gestor_id, codigo_producto, periodo, avance_reportado, porcentaje_cumplimiento)
                          VALUES (?,?,?,?,?)`).run(req.gestor.id, v.codprod, v.periodo, v.avance, v.porcentaje);
    res.status(201).json({ id: Number(r.lastInsertRowid), porcentaje: v.porcentaje });
  });

  app.put('/api/cumplimientos/:id', requiereGestor, (req, res) => {
    const c = propio(req, res); if (!c) return;
    const v = validar(req.body || {}, req.gestor);
    if (v.error) return res.status(v.status).json({ error: v.error });
    db.prepare(`UPDATE cumplimientos SET codigo_producto=?, periodo=?, avance_reportado=?, porcentaje_cumplimiento=?,
                actualizado_en=datetime('now') WHERE id_cumplimiento=?`).run(v.codprod, v.periodo, v.avance, v.porcentaje, c.id);
    res.json({ id: c.id, porcentaje: v.porcentaje });
  });

  // Un archivo por petición: el cuerpo es el archivo y su nombre viene en X-Nombre-Archivo
  app.post('/api/cumplimientos/:id/evidencias', requiereGestor, express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
    const c = propio(req, res); if (!c) return;
    const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const buf = req.body;
    if (!FIRMAS[tipo]) return res.status(400).json({ error: 'Solo se permiten archivos JPG, PNG o PDF' });
    if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_BYTES) return res.status(400).json({ error: 'El archivo está vacío o supera los 10 MB' });
    if (!FIRMAS[tipo].every((byte, i) => buf[i] === byte)) return res.status(400).json({ error: 'El contenido del archivo no corresponde a su tipo' });
    if (db.prepare('SELECT COUNT(*) AS n FROM evidencias WHERE id_cumplimiento=?').get(c.id).n >= MAX_ARCHIVOS)
      return res.status(400).json({ error: 'Máximo ' + MAX_ARCHIVOS + ' archivos por cumplimiento' });
    let nombre = '';
    try { nombre = decodeURIComponent(String(req.headers['x-nombre-archivo'] || '')); } catch (e) { /* nombre vacío */ }
    nombre = nombre.replace(/[\\/]/g, '_').trim().slice(0, 200) || 'evidencia';
    const r = db.prepare('INSERT INTO evidencias (id_cumplimiento, nombre_archivo, tipo, archivo, tamano) VALUES (?,?,?,?,?)')
      .run(c.id, nombre, tipo, buf, buf.length);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // Pasa el cumplimiento a revisión (queda Pendiente para el gestor líder)
  app.post('/api/cumplimientos/:id/enviar', requiereGestor, (req, res) => {
    const c = propio(req, res); if (!c) return;
    if (!db.prepare('SELECT 1 FROM evidencias WHERE id_cumplimiento=?').get(c.id))
      return res.status(400).json({ error: 'Adjunta al menos un archivo de evidencia antes de enviar' });
    const f = db.prepare('SELECT codigo_producto AS codprod, periodo, avance_reportado AS avance FROM cumplimientos WHERE id_cumplimiento=?').get(c.id);
    const v = validar(f, req.gestor); // vuelve a calcular con lo registrado hasta hoy
    if (v.error) return res.status(v.status).json({ error: v.error });
    db.prepare("UPDATE cumplimientos SET porcentaje_cumplimiento=?, estado_revision='Pendiente', actualizado_en=datetime('now') WHERE id_cumplimiento=?")
      .run(v.porcentaje, c.id);
    res.json({ id: c.id, estado: 'Pendiente', porcentaje: v.porcentaje });
  });

  return { loginGestor, gestorDeSesion };
};
