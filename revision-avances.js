/* =====================================================================
   Revisión de avances (revision-avances.html)
   Quien revisa ve los cumplimientos ENVIADOS por sus gestores (los de
   su administrador; un superadministrador ve los de todos) y los
   aprueba o los devuelve con una observación. Los borradores no se ven.
   ===================================================================== */

module.exports = function (app, db, { requiereSesion }) {
  const ESTADOS = ['Pendiente', 'Aprobado', 'Devuelto'];

  // Qué gestores puede ver quien revisa (la tabla gestores se llama siempre «g»)
  const alcance = admin => admin.rol === 'Superadministrador'
    ? { sql: '1=1', params: [] }
    : { sql: 'g.administrador_id = ?', params: [admin.id] };

  const BASE = `
    FROM cumplimientos c
    JOIN gestores g ON g.id_gestor = c.gestor_id
    JOIN productos pr ON pr.codigo_producto = c.codigo_producto
    WHERE c.estado_revision <> 'Borrador'`;

  // Filtro «Gestor»
  app.get('/api/revision/gestores', requiereSesion, (req, res) => {
    const al = alcance(req.admin);
    res.json(db.prepare(`SELECT g.id_gestor AS id, g.nombre FROM gestores g WHERE ${al.sql} ORDER BY g.nombre`).all(...al.params));
  });

  // Las tres tarjetas de arriba
  app.get('/api/revision/resumen', requiereSesion, (req, res) => {
    const al = alcance(req.admin);
    res.json(db.prepare(`
      SELECT COALESCE(SUM(c.estado_revision = 'Pendiente'), 0) AS pendientes,
             COALESCE(SUM(c.estado_revision = 'Aprobado'
                          AND date(COALESCE(c.fecha_revision, c.fecha_registro)) >= date('now', '-7 days')), 0) AS aprobadosSemana,
             COALESCE(SUM(c.estado_revision = 'Devuelto'), 0) AS devueltos
      ${BASE} AND ${al.sql}`).get(...al.params));
  });

  // Lista de avances con sus evidencias, según los filtros de la página
  app.get('/api/revision/avances', requiereSesion, (req, res) => {
    const al = alcance(req.admin), q = req.query;
    const estado = String(q.estado ?? ''), periodo = String(q.periodo ?? '');
    const gestor = String(q.gestor ?? ''), texto = String(q.q ?? '').trim();

    const cond = [], par = [...al.params];
    if (ESTADOS.includes(estado)) { cond.push('c.estado_revision = ?'); par.push(estado); }
    if (['Mensual', 'Trimestral'].includes(periodo)) { cond.push('c.periodo = ?'); par.push(periodo); }
    if (/^\d+$/.test(gestor)) { cond.push('c.gestor_id = ?'); par.push(Number(gestor)); }
    if (texto) {
      const like = '%' + texto.replace(/[\\%_]/g, m => '\\' + m) + '%';
      cond.push("(g.nombre LIKE ? ESCAPE '\\' OR pr.codigo_indicador_producto LIKE ? ESCAPE '\\')");
      par.push(like, like);
    }

    const filas = db.prepare(`
      SELECT c.id_cumplimiento AS id, c.gestor_id AS gestorId, g.nombre AS gestorNombre,
             pr.codigo_indicador_producto AS codind, c.periodo, pr.meta_redactada AS metared,
             pr.nombre_producto AS nomprod, pr.indicador_producto AS indprod,
             pr.meta_cuatrienio AS metacuatrienio, c.avance_reportado AS avance,
             c.porcentaje_cumplimiento AS porcentaje, c.fecha_registro AS fecha,
             c.estado_revision AS estado, c.observacion_revision AS observacion
      ${BASE} AND ${al.sql}${cond.length ? ' AND ' + cond.join(' AND ') : ''}
      ORDER BY c.id_cumplimiento DESC`).all(...par);

    const evid = db.prepare(`SELECT id_evidencia AS id, nombre_archivo AS nombre, tipo, creado_en AS creado
                             FROM evidencias WHERE id_cumplimiento = ? ORDER BY id_evidencia`);
    filas.forEach(f => { f.evidencias = evid.all(f.id); });
    res.json(filas);
  });

  // «Ver archivo completo»: se abre en otra pestaña
  app.get('/api/revision/avances/:id/evidencias/:eid', requiereSesion, (req, res) => {
    const al = alcance(req.admin);
    const f = db.prepare(`
      SELECT e.nombre_archivo, e.tipo, e.archivo
      FROM evidencias e
      JOIN cumplimientos c ON c.id_cumplimiento = e.id_cumplimiento
      JOIN gestores g ON g.id_gestor = c.gestor_id
      WHERE e.id_evidencia = ? AND e.id_cumplimiento = ? AND c.estado_revision <> 'Borrador' AND ${al.sql}`)
      .get(req.params.eid, req.params.id, ...al.params);
    if (!f) return res.status(404).json({ error: 'No se encontró ese archivo' });
    res.set({
      'Content-Type': f.tipo,
      'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(f.nombre_archivo),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=0'
    });
    res.send(f.archivo);
  });

  // Aprobar o devolver: solo un avance Pendiente de un gestor al alcance de quien revisa
  function decidir(req, res, nuevoEstado) {
    const obs = String((req.body || {}).observacion ?? '').trim().slice(0, 1000);
    if (nuevoEstado === 'Devuelto' && !obs)
      return res.status(400).json({ error: 'Escribe una observación para devolver el avance al gestor' });
    const al = alcance(req.admin);
    const c = db.prepare(`
      SELECT c.id_cumplimiento AS id, c.estado_revision AS estado
      FROM cumplimientos c JOIN gestores g ON g.id_gestor = c.gestor_id
      WHERE c.id_cumplimiento = ? AND ${al.sql}`).get(req.params.id, ...al.params);
    if (!c) return res.status(404).json({ error: 'No se encontró ese avance entre los de tus gestores' });
    if (c.estado !== 'Pendiente') return res.status(409).json({ error: 'Este avance ya fue revisado o todavía no se ha enviado' });
    db.prepare(`UPDATE cumplimientos SET estado_revision = ?, observacion_revision = ?, revisado_por = ?,
                fecha_revision = datetime('now'), actualizado_en = datetime('now')
                WHERE id_cumplimiento = ? AND estado_revision = 'Pendiente'`).run(nuevoEstado, obs || null, req.admin.id, c.id);
    res.json({ id: c.id, estado: nuevoEstado });
  }

  app.post('/api/revision/avances/:id/aprobar', requiereSesion, (req, res) => decidir(req, res, 'Aprobado'));
  app.post('/api/revision/avances/:id/devolver', requiereSesion, (req, res) => decidir(req, res, 'Devuelto'));
};
