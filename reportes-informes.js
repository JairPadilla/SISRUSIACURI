/* =====================================================================
   Reportes y exportación de informes (reportes-informes.html)

   Quién ve qué:
   · Superadministrador → todos los gestores activos.
   · Administrador      → solo los gestores que tiene a su cargo.
   · Gestor líder       → los gestores que trabajan en su sector (o sectores),
                          y solo con los indicadores de ese sector.

   Cómo se calcula (por gestor):
   · Avance promedio = promedio de sus indicadores con meta; cada uno es el
     avance APROBADO acumulado ÷ meta del cuatrienio (máx. 100 %).
   · Estado: «Con pendientes» si tiene avances devueltos por corregir;
     «En revisión» si tiene avances enviados esperando revisión;
     «Al día» si no tiene ni lo uno ni lo otro; «Sin asignaciones» si no tiene indicadores.
   ===================================================================== */

module.exports = function (app, db, { adminDeSesion, gestorDeSesion }) {
  const PERIODICIDADES = ['Mensual', 'Trimestral'];
  const porNombre = (a, b) => a.localeCompare(b, 'es');
  const suma = a => a.reduce((s, x) => s + (x || 0), 0);

  function consultante(req) {
    const admin = adminDeSesion(req);
    if (admin) return { tipo: 'admin', usuario: admin };
    const gestor = gestorDeSesion(req);
    return gestor ? { tipo: 'gestor', usuario: gestor } : null;
  }

  // Gestores e indicadores asignados que quien consulta puede ver
  function cargarAlcance(c) {
    const porAdmin = c.tipo === 'admin' && c.usuario.rol !== 'Superadministrador';
    const cond = porAdmin ? 'AND g.administrador_id = ?' : '';
    const par = porAdmin ? [c.usuario.id] : [];

    let gestores = db.prepare(`SELECT g.id_gestor AS id, g.nombre FROM gestores g
                               WHERE g.estado = 'Activo' ${cond} ORDER BY g.id_gestor`).all(...par);
    let inds = db.prepare(`
      SELECT a.gestor_id AS gestorId, a.codigo_producto AS cod, pr.codigo_indicador_producto AS codind,
             pr.nombre_producto AS producto, pr.meta_redactada AS metared, pr.meta_cuatrienio AS meta,
             COALESCE(NULLIF(p.sector, ''), 'Sin sector') AS sector
      FROM asignaciones a
      JOIN productos pr ON pr.codigo_producto = a.codigo_producto
      JOIN programas p ON p.codigo_programa = pr.codigo_programa
      JOIN gestores g ON g.id_gestor = a.gestor_id
      WHERE g.estado = 'Activo' ${cond}`).all(...par);

    if (c.tipo === 'gestor') {                       // gestor líder: solo su sector
      const mios = new Set(inds.filter(i => i.gestorId === c.usuario.id).map(i => i.sector));
      inds = inds.filter(i => mios.has(i.sector));
      const conIndicadores = new Set(inds.map(i => i.gestorId));
      gestores = gestores.filter(g => conIndicadores.has(g.id));
    }
    return { gestores, inds };
  }

  function calcular(c, { periodicidad = '', sector = '' } = {}) {
    const { gestores, inds } = cargarAlcance(c);
    const sectores = [...new Set(inds.map(i => i.sector))].sort(porNombre);
    if (!sectores.includes(sector)) sector = '';   // solo valen los sectores dentro del alcance

    // Avances enviados (no borradores), agrupados por indicador
    const reps = db.prepare(`SELECT codigo_producto AS cod, avance_reportado AS avance, estado_revision AS estado, fecha_registro AS fecha
                             FROM cumplimientos WHERE estado_revision <> 'Borrador'${periodicidad ? ' AND periodo = ?' : ''}`)
      .all(...(periodicidad ? [periodicidad] : []));
    const porCod = new Map();
    reps.forEach(r => { if (!porCod.has(r.cod)) porCod.set(r.cod, []); porCod.get(r.cod).push(r); });

    function estadisticas(i) {
      const rs = porCod.get(i.cod) || [];
      const aprobado = suma(rs.filter(r => r.estado === 'Aprobado').map(r => r.avance));
      const fechas = rs.map(r => r.fecha).sort();
      return {
        aprobado, porcentaje: i.meta > 0 ? Math.min(100, aprobado / i.meta * 100) : null,
        aprobados: rs.filter(r => r.estado === 'Aprobado').length,
        pendientes: rs.filter(r => r.estado === 'Pendiente').length,
        devueltos: rs.filter(r => r.estado === 'Devuelto').length,
        ultimo: fechas.length ? fechas[fechas.length - 1] : null
      };
    }

    const vista = sector ? inds.filter(i => i.sector === sector) : inds;
    const filas = [], detalle = new Map();
    gestores.forEach(g => {
      const mios = vista.filter(i => i.gestorId === g.id);
      if (sector && !mios.length) return;
      const est = mios.map(i => ({ ...i, ...estadisticas(i) }));
      const pcts = est.map(e => e.porcentaje).filter(p => p !== null);
      const pendientes = suma(est.map(e => e.pendientes)), devueltos = suma(est.map(e => e.devueltos));
      const ultimos = est.map(e => e.ultimo).filter(Boolean).sort();
      filas.push({
        id: g.id, nombre: g.nombre, sectores: [...new Set(mios.map(i => i.sector))].sort(porNombre),
        indicadores: mios.length, avance: Math.round(pcts.length ? suma(pcts) / pcts.length : 0),
        pendientes, devueltos,
        estado: !mios.length ? 'Sin asignaciones' : devueltos ? 'Con pendientes' : pendientes ? 'En revisión' : 'Al día',
        ultimo: ultimos.length ? ultimos[ultimos.length - 1] : null
      });
      detalle.set(g.id, est);
    });
    return { sectores, sector, filas, detalle };
  }

  function textoVista(c, sectores) {
    if (c.tipo === 'gestor') return 'Gestor líder · ' + (sectores.join(', ') || 'sin sector');
    return c.usuario.rol === 'Superadministrador' ? 'Superadministrador · Todos los sectores' : 'Administrador · Mis gestores';
  }

  // Valida la sesión: administradores y gestores líderes
  function conAcceso(req, res) {
    const c = consultante(req);
    if (!c) { res.status(401).json({ error: 'Debes iniciar sesión' }); return null; }
    if (c.tipo === 'gestor' && c.usuario.rol !== 'Gestor líder') {
      res.status(403).json({ error: 'Los reportes son para administradores y gestores líderes', rol: c.usuario.rol });
      return null;
    }
    return c;
  }

  // Informe por gestor (tabla y KPIs de la página)
  app.get('/api/reportes/gestores', (req, res) => {
    const c = conAcceso(req, res); if (!c) return;
    const periodicidad = PERIODICIDADES.includes(String(req.query.periodicidad ?? '')) ? String(req.query.periodicidad) : '';
    const r = calcular(c, { periodicidad, sector: String(req.query.sector ?? '') });
    res.set('Cache-Control', 'no-store');
    res.json({
      sesion: c.tipo, rol: c.usuario.rol, vista: textoVista(c, r.sectores),
      sectores: r.sectores, sector: r.sector, periodicidad, gestores: r.filas
    });
  });

  // Informe detallado de un gestor: sus indicadores (para «Exportar» de cada fila)
  app.get('/api/reportes/gestores/:id', (req, res) => {
    const c = conAcceso(req, res); if (!c) return;
    const periodicidad = PERIODICIDADES.includes(String(req.query.periodicidad ?? '')) ? String(req.query.periodicidad) : '';
    const r = calcular(c, { periodicidad });
    const g = r.filas.find(f => String(f.id) === String(req.params.id));
    if (!g) return res.status(404).json({ error: 'No se encontró ese gestor entre los tuyos' });
    res.json({
      gestor: { id: g.id, nombre: g.nombre, estado: g.estado, avance: g.avance, ultimo: g.ultimo },
      indicadores: r.detalle.get(g.id).map(i => ({
        codind: i.codind, producto: i.producto, meta: i.metared, sector: i.sector, metaCuatrienio: i.meta,
        avanceAprobado: i.aprobado, porcentaje: i.porcentaje === null ? null : Math.round(i.porcentaje),
        aprobados: i.aprobados, pendientes: i.pendientes, devueltos: i.devueltos, ultimo: i.ultimo
      }))
    });
  });
};
