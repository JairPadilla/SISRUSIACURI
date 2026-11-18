/* =====================================================================
   Tablero general de avances y cumplimientos (tablero-general.html)

   Quién ve qué:
   · Superadministrador → todos los sectores.
   · Administrador      → solo los indicadores de los gestores que tiene a su cargo.
   · Gestor líder       → solo el sector (o sectores) de los indicadores que tiene asignados.

   Cómo se calcula:
   · Avance de un indicador = avance APROBADO acumulado ÷ meta del cuatrienio (máx. 100 %).
   · Cumplimiento de un sector = promedio de sus indicadores con meta.
   · Cumplimiento general = promedio de los sectores.
   · Al día ≥ 70 % · En curso 30–69 % · En riesgo < 30 %.
   ===================================================================== */

module.exports = function (app, db, { adminDeSesion, gestorDeSesion, ahora = () => new Date() }) {
  const AL_DIA = 70, RIESGO = 30;
  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const prom = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const estadoDe = p => p >= AL_DIA ? 'Al día' : p >= RIESGO ? 'En curso' : 'En riesgo';
  const ETIQ_TRIM = { 1: 'T1 · ene–mar', 2: 'T2 · abr–jun', 3: 'T3 · jul–sep', 4: 'T4 · oct–dic' };

  function trimestre(y, q) {
    const m0 = (q - 1) * 3 + 1;
    return { desde: iso(y, m0, 1), hasta: iso(y, m0 + 2, new Date(Date.UTC(y, m0 + 2, 0)).getUTCDate()) };
  }

  // Quién consulta: un administrador, o un gestor con rol «Gestor líder»
  function consultante(req) {
    const admin = adminDeSesion(req);
    if (admin) return { tipo: 'admin', usuario: admin };
    const gestor = gestorDeSesion(req);
    return gestor ? { tipo: 'gestor', usuario: gestor } : null;
  }

  // Condición SQL que limita los indicadores visibles (alias: g = gestores, p = programas)
  function alcance(c) {
    if (c.tipo === 'gestor') return {
      sql: `p.sector IN (SELECT p2.sector FROM asignaciones a2
                         JOIN productos pr2 ON pr2.codigo_producto = a2.codigo_producto
                         JOIN programas p2 ON p2.codigo_programa = pr2.codigo_programa
                         WHERE a2.gestor_id = ?)`,
      params: [c.usuario.id]
    };
    if (c.usuario.rol === 'Superadministrador') return { sql: '1=1', params: [] };
    return { sql: 'g.administrador_id = ?', params: [c.usuario.id] };
  }

  const FROM = `
    FROM asignaciones a
    JOIN productos pr ON pr.codigo_producto = a.codigo_producto
    JOIN programas p ON p.codigo_programa = pr.codigo_programa
    JOIN gestores g ON g.id_gestor = a.gestor_id`;

  app.get('/api/tablero', (req, res) => {
    const c = consultante(req);
    if (!c) return res.status(401).json({ error: 'Debes iniciar sesión' });
    if (c.tipo === 'gestor' && c.usuario.rol !== 'Gestor líder')
      return res.status(403).json({ error: 'El tablero general es para administradores y gestores líderes', rol: c.usuario.rol });

    const al = alcance(c);

    // Indicadores asignados dentro del alcance
    const filas = db.prepare(`
      SELECT a.codigo_producto AS cod, pr.meta_cuatrienio AS meta, COALESCE(NULLIF(p.sector, ''), 'Sin sector') AS sector,
             g.nombre AS gestor, ad.nombre AS administrador
      ${FROM}
      JOIN administradores ad ON ad.id = g.administrador_id
      WHERE ${al.sql}`).all(...al.params);

    // Avances enviados (no borradores) de esos indicadores
    const reps = db.prepare(`
      SELECT c.codigo_producto AS cod, c.avance_reportado AS avance, c.estado_revision AS estado, c.fecha_registro AS fecha
      FROM cumplimientos c
      JOIN asignaciones a ON a.codigo_producto = c.codigo_producto
      JOIN productos pr ON pr.codigo_producto = a.codigo_producto
      JOIN programas p ON p.codigo_programa = pr.codigo_programa
      JOIN gestores g ON g.id_gestor = a.gestor_id
      WHERE c.estado_revision <> 'Borrador' AND ${al.sql}`).all(...al.params);

    // Fechas y periodo elegido
    const d = ahora(), y = d.getFullYear(), hoy = iso(y, d.getMonth() + 1, d.getDate());
    const qActual = Math.floor(d.getMonth() / 3) + 1;
    let periodo = String(req.query.periodo ?? 'actual');
    if (periodo !== 'anio' && periodo !== 'actual' && !(/^T[1-4]$/.test(periodo) && Number(periodo[1]) <= qActual)) periodo = 'actual';
    const qSel = periodo === 'actual' ? qActual : Number(periodo[1]);
    const rango = periodo === 'anio'
      ? { desde: iso(y, 1, 1), hasta: hoy }
      : (t => ({ desde: t.desde, hasta: t.hasta < hoy ? t.hasta : hoy }))(trimestre(y, qSel));

    const periodos = [{ valor: 'actual', etiqueta: 'Trimestre actual' }];
    for (let q = 1; q <= qActual; q++) periodos.push({ valor: 'T' + q, etiqueta: ETIQ_TRIM[q] });
    periodos.push({ valor: 'anio', etiqueta: 'Año en curso' });

    // Sector elegido (solo valen los que están dentro del alcance)
    const sectores = [...new Set(filas.map(f => f.sector))].sort((a, b) => a.localeCompare(b, 'es'));
    const sector = sectores.includes(String(req.query.sector ?? '')) ? String(req.query.sector) : '';
    const vista = sector ? filas.filter(f => f.sector === sector) : filas;
    const codigos = new Set(vista.map(f => f.cod));
    const repsVista = reps.filter(r => codigos.has(r.cod));

    // Cumplimiento por sector con lo aprobado hasta una fecha
    function porSectorHasta(hasta) {
      const acum = new Map();
      repsVista.forEach(r => { if (r.estado === 'Aprobado' && r.fecha <= hasta) acum.set(r.cod, (acum.get(r.cod) || 0) + (r.avance || 0)); });
      const grupos = new Map();
      vista.forEach(f => {
        if (!grupos.has(f.sector)) grupos.set(f.sector, { sector: f.sector, pcts: [], indicadores: 0, administradores: new Set(), gestores: new Set() });
        const g = grupos.get(f.sector);
        g.indicadores++; g.administradores.add(f.administrador); g.gestores.add(f.gestor);
        if (f.meta > 0) g.pcts.push(Math.min(100, (acum.get(f.cod) || 0) / f.meta * 100));
      });
      return [...grupos.values()].map(g => ({ ...g, pct: prom(g.pcts) }));
    }

    const actual = porSectorHasta(rango.hasta);
    const porSector = actual.map(g => ({
      sector: g.sector, cumplimiento: Math.round(g.pct), estado: estadoDe(g.pct), indicadores: g.indicadores,
      administradores: [...g.administradores].sort(), gestores: [...g.gestores].sort()
    })).sort((a, b) => b.cumplimiento - a.cumplimiento || a.sector.localeCompare(b.sector, 'es'));

    // Estado de los reportes registrados dentro del periodo
    const enPeriodo = repsVista.filter(r => r.fecha >= rango.desde && r.fecha <= rango.hasta);
    const cuenta = e => enPeriodo.filter(r => r.estado === e).length;

    // Evolución del año: cumplimiento general al cierre de cada trimestre
    const evolucion = [1, 2, 3, 4].map(q => {
      const t = trimestre(y, q);
      return {
        etiqueta: 'T' + q, actual: q === qActual,
        valor: t.desde > hoy ? null : Math.round(prom(porSectorHasta(t.hasta < hoy ? t.hasta : hoy).map(g => g.pct)))
      };
    });

    const textoVista = c.tipo === 'gestor' ? 'Gestor líder · ' + (sectores.join(', ') || 'sin sector')
      : c.usuario.rol === 'Superadministrador' ? 'Superadministrador · Todos los sectores' : 'Administrador · Mis gestores';

    res.set('Cache-Control', 'no-store');
    res.json({
      sesion: c.tipo, rol: c.usuario.rol, usuario: { nombre: c.usuario.nombre, cargo: c.usuario.cargo }, vista: textoVista,
      periodos, periodo, sectores, sector,
      kpi: {
        general: Math.round(prom(actual.map(g => g.pct))), indicadores: vista.length,
        sectoresActivos: actual.length, sectoresRiesgo: actual.filter(g => g.pct < RIESGO).length
      },
      porSector,
      reportes: { aprobados: cuenta('Aprobado'), pendientes: cuenta('Pendiente'), devueltos: cuenta('Devuelto'), total: enPeriodo.length },
      evolucion
    });
  });
};
