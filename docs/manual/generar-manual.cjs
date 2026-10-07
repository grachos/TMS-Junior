#!/usr/bin/env node
/**
 * Konekto - Genera el manual rápido en PDF (docs/manual/Konekto-Manual-Rapido.pdf).
 *
 * Abre la app real (vite dev server) en Chrome y responde TODAS las llamadas a
 * /api con datos inventados definidos aquí: no necesita base de datos y nunca
 * toca datos reales ni credenciales. Toma las capturas, les pone números y arma
 * el PDF con el mismo Chrome.
 *
 *   npm run dev:client            # en otra terminal (http://localhost:5173)
 *   node docs/manual/generar-manual.cjs
 *
 * Variables opcionales: BASE_URL, CHROME_PATH.
 */

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const OUT = __dirname;
const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => fs.existsSync(p));

// ---------------------------------------------------------------------------
// Datos de demostración (todo inventado)
// ---------------------------------------------------------------------------
const USER = { id: 1, email: 'admin@demo.co', nombre: 'Ana Demostración', rol: 'admin', paginas: null, activo: 1, created_at: '2026-01-01' };

const TERCEROS = [
  { id: 1, tipo_id: 'N', num_id: '900100200', nombre: 'AGROINDUSTRIAL EL PALMAR S.A.S.', municipio_nombre: 'Medellín – Antioquia', es_conductor: 0, estado_rndc: 'registrado' },
  { id: 2, tipo_id: 'N', num_id: '900300400', nombre: 'DISTRIBUIDORA ANDINA DE ALIMENTOS S.A.S.', municipio_nombre: 'Barranquilla – Atlántico', es_conductor: 0, estado_rndc: 'registrado' },
  { id: 3, tipo_id: 'N', num_id: '800500600', nombre: 'COMERCIALIZADORA CARIBE NORTE LTDA.', municipio_nombre: 'Cartagena – Bolívar', es_conductor: 0, estado_rndc: 'registrado' },
  { id: 4, tipo_id: 'C', num_id: '70100200', nombre: 'CARLOS MENDOZA ROJAS', municipio_nombre: 'Medellín – Antioquia', es_conductor: 1, estado_rndc: 'registrado' },
  { id: 5, tipo_id: 'C', num_id: '70300400', nombre: 'LUIS FERNANDO DIAZ PAREJA', municipio_nombre: 'Bogotá D.C.', es_conductor: 1, estado_rndc: 'pendiente' },
  { id: 6, tipo_id: 'N', num_id: '901700800', nombre: 'TRANSPORTES HORIZONTE S.A.S.', municipio_nombre: 'Bogotá D.C.', es_conductor: 0, estado_rndc: 'registrado' },
];

const VEHICULOS = [
  { id: 1, placa: 'DEM123', remolque_placa: 'R11111', cod_configuracion: '3S3', cod_configuracion_nombre: 'Tractocamión 3 ejes + semirremolque 3 ejes', tenedor_num_id: '900100200', estado_rndc: 'registrado' },
  { id: 2, placa: 'DEM456', remolque_placa: 'R22222', cod_configuracion: '3S2', cod_configuracion_nombre: 'Tractocamión 3 ejes + semirremolque 2 ejes', tenedor_num_id: '70100200', estado_rndc: 'registrado' },
  { id: 3, placa: 'DEM789', remolque_placa: null, cod_configuracion: '2', cod_configuracion_nombre: 'Camión rígido 2 ejes', tenedor_num_id: '901700800', estado_rndc: 'pendiente' },
];

const PRODUCTOS = [
  { codigo: '009990', nombre: 'CONTENEDOR VACÍO', tipo: 'Otros', codigo_un: null, estado_producto: null },
  { codigo: '0101001', nombre: 'ACEITE DE PALMA CRUDO', tipo: 'Alimentos', codigo_un: null, estado_producto: null },
  { codigo: '0204002', nombre: 'ARROZ BLANCO EMPACADO', tipo: 'Alimentos', codigo_un: null, estado_producto: null },
  { codigo: '0309003', nombre: 'FERTILIZANTE COMPUESTO', tipo: 'Agroquímicos', codigo_un: 'UN2071', estado_producto: 'S' },
];

const SOL = {
  id: 1046, consecutivo: '1046', fecha_solicitud: '2026-10-05', operacion_transporte: 'G', naturaleza_carga: '1',
  municipio_origen: 'Medellín – Antioquia', municipio_destino: 'Barranquilla – Atlántico', descripcion_producto: 'ACEITE DE PALMA CRUDO',
  valor_flete: 5200000, retencion_ica: 31200, retencion_fuente: 52000, fopat: 5200, cantidad_vehiculos: 1, cantidad_vehiculos_original: 2,
  peso: 34000, peso_disponible: 17000, estado: 'procesada', unidad_medida: '1', tipo_empaque: '', mercancia_codigo: '0101001',
  remitente_tipo_id: 'N', remitente_num_id: '900100200', destinatario_tipo_id: 'N', destinatario_num_id: '900300400',
  generador_tipo_id: 'N', generador_num_id: '900100200', dueno_poliza: 'N', tipo_viaje: 'NACIONAL', tipo_flete: 'G', tipo_valor_pactado: 'V',
};

const SOLICITUDES = [
  ['1048', 'borrador', 'Cali', 'Bogotá D.C.', 3800000, 1, 1],
  ['1047', 'procesada', 'Bogotá D.C.', 'Medellín', 4100000, 1, 3],
  ['1046', 'procesada', 'Medellín', 'Barranquilla', 5200000, 1, 2],
  ['1045', 'despachada', 'Cartagena', 'Medellín', 6350000, 0, 1],
  ['1044', 'despachada', 'Barranquilla', 'Bogotá D.C.', 7800000, 0, 2],
  ['1043', 'despachada', 'Medellín', 'Cali', 4650000, 0, 1],
  ['1042', 'despachada', 'Bogotá D.C.', 'Cartagena', 8200000, 0, 1],
].map(([c, estado, o, d, flete, rest, orig], i) => ({
  id: Number(c), consecutivo: c, estado, fecha_solicitud: `2026-10-0${Math.max(1, 5 - Math.floor(i / 2))}`, origen_nombre: o, destino_nombre: d,
  municipio_origen: o, municipio_destino: d, valor_flete: flete, cantidad_vehiculos: rest, cantidad_vehiculos_original: orig,
}));

const DESPACHOS = [
  ['1047', 'REM-00034', '0100001240', 'aceptado', 'aceptado'],
  ['1046', 'REM-00033', '0100001239', 'aceptado', 'aceptado'],
  ['1046', 'REM-00032', '0100001238', 'enviado', 'enviado'],
  ['1045', 'REM-00031', '0100001237', 'pendiente', 'pendiente'],
  ['1044', 'REM-00030', '0100001236', 'aceptado', 'aceptado'],
  ['1043', 'REM-00029', '0100001235', 'aceptado', 'aceptado'],
].map(([cons, rem, man, er, em], i) => ({
  remesa_id: 300 - i, solicitud_id: Number(cons), consecutivo: cons, num_remesa: rem.replace('REM-', '01012') , num_manifiesto: man, manifiesto_id: 200 - i,
  created_at: `2026-10-0${5 - Math.floor(i / 2)} ${9 + i}:2${i}:00`, estado_remesa: er, estado_manifiesto: em, seguridadqr: em === 'aceptado' ? 'A1B2C3' : null, seguridadqr_error: null,
}));

const COLA = [
  ['1047', 'remesa', 3, 'pendiente'], ['1047', 'manifiesto', 4, 'pendiente'], ['1046', 'remesa', 3, 'enviando'], ['1046', 'manifiesto', 4, 'pendiente'],
  ['1045', 'cumplido_remesa', 5, 'enviado'], ['1045', 'cumplido_manifiesto', 6, 'enviado'], ['1044', 'remesa', 3, 'enviado'], ['1044', 'manifiesto', 4, 'error'],
].map(([cons, tipo, proc, estado], i) => ({
  id: 900 - i, consecutivo: cons, solicitud_id: Number(cons), tipo_documento: tipo, proceso_rndc: proc, estado, estado_origen: null, intentos: estado === 'error' ? 3 : estado === 'pendiente' ? 0 : 1,
  max_intentos: 10, rndc_ingreso_id: estado === 'enviado' ? String(118000000 + i * 137) : null,
  ultimo_error: estado === 'error' ? 'El RNDC rechazó el documento: revisa la sede del destinatario.' : estado === 'pendiente' ? 'Modo seguro: envío deshabilitado.' : null,
}));

const CUMPLIDO = [
  { manifiesto_id: 200, consecutivo: '1047', solicitud_id: 1047, num_manifiesto: '0100001240', placa: 'DEM123', remesas: 1 },
  { manifiesto_id: 199, consecutivo: '1046', solicitud_id: 1046, num_manifiesto: '0100001239', placa: 'DEM456', remesas: 1 },
  { manifiesto_id: 197, consecutivo: '1044', solicitud_id: 1044, num_manifiesto: '0100001236', placa: 'DEM123', remesas: 2 },
];

const INFORME = {
  columns: [
    { key: 'num_remesa', header: 'Remesa' }, { key: 'num_manifiesto', header: 'Manifiesto' }, { key: 'estado', header: 'Estado' },
    { key: 'cliente', header: 'Cliente' }, { key: 'conductor', header: 'Conductor' }, { key: 'peso', header: 'Peso (kg)' },
    { key: 'valor_flete', header: 'Flete' }, { key: 'retencion_fuente', header: 'Ret. fuente' },
  ],
  items: [
    ['0101200034', '0100001240', 'despachado', 'AGROINDUSTRIAL EL PALMAR S.A.S.', 'CARLOS MENDOZA ROJAS', 17000, 5200000, 52000],
    ['0101200033', '0100001239', 'cumplido', 'DISTRIBUIDORA ANDINA DE ALIMENTOS S.A.S.', 'LUIS FERNANDO DIAZ PAREJA', 24000, 6350000, 63500],
    ['0101200032', '0100001238', 'despachado', 'COMERCIALIZADORA CARIBE NORTE LTDA.', 'CARLOS MENDOZA ROJAS', 30000, 7800000, 78000],
    ['0101200031', '0100001237', 'cumplido', 'AGROINDUSTRIAL EL PALMAR S.A.S.', 'LUIS FERNANDO DIAZ PAREJA', 28000, 4650000, 46500],
    ['0101200030', '0100001236', 'anulado', 'DISTRIBUIDORA ANDINA DE ALIMENTOS S.A.S.', 'CARLOS MENDOZA ROJAS', 12000, 3100000, 31000],
  ].map(([num_remesa, num_manifiesto, estado, cliente, conductor, peso, valor_flete, retencion_fuente], i) => ({
    id_remesa: 500 + i, id_manifiesto: 200 - i, num_remesa, num_manifiesto, estado, cliente, conductor, peso, valor_flete, retencion_fuente,
  })),
  total: 5, pagina: 1, paginas: 1,
};

const EMPRESA = {
  tipo_id: 'N', nit: '900000001', razon_social: 'TRANSPORTES DEMO S.A.S.', direccion: 'Calle 00 # 00-00', telefono: '6000000', cod_municipio: '11001000',
  municipio_nombre: 'Bogotá D.C.', nro_poliza: 'POL-000000', emf: '900000002', consecutivo_manifiesto: 1241, consecutivo_remesa: 35,
  aseguradora_carga_nombre: 'ASEGURADORA DEMO S.A.', aseguradora_carga_nit: '900000003', poliza_carga_numero: 'MP-000000', poliza_carga_vencimiento: '2027-06-30',
  rndc_username: 'usuario@demo', rndc_password: 'demo-no-real',
};

const USUARIOS = [
  { id: 1, email: 'admin@demo.co', nombre: 'Ana Demostración', rol: 'admin', paginas: null, activo: 1 },
  { id: 2, email: 'despachos@demo.co', nombre: 'Pedro Operador', rol: 'operador', paginas: ['solicitudes', 'despachos', 'cumplido'], activo: 1 },
  { id: 3, email: 'consulta@demo.co', nombre: 'Marta Consulta', rol: 'operador', paginas: ['informe'], activo: 1 },
];

const STATS = {
  colaPorEstado: [{ estado: 'pendiente', n: 4 }, { estado: 'enviado', n: 18 }, { estado: 'error', n: 1 }],
  solicitudesPorEstado: [{ estado: 'borrador', n: 3 }, { estado: 'procesada', n: 8 }, { estado: 'despachada', n: 24 }],
  despachosPorDia: Array.from({ length: 14 }, (_, i) => ({ dia: `2026-09-${String(24 + (i % 7)).padStart(2, '0')}`, n: [2, 4, 3, 6, 5, 8, 4, 7, 9, 6, 5, 8, 10, 7][i] })).map((d, i) => ({ ...d, dia: i < 7 ? `2026-09-${24 + i}` : `2026-10-0${i - 6}` })),
  totales: { solicitudes: 35, remesas: 52, manifiestos: 31, cola_pendiente: 4, cola_error: 1 },
};

const paged = (items, total = items.length) => ({ items, total, pagina: 1, paginas: 1 });

function api(pathname, query) {
  const p = pathname.replace(/^\/api/, '');
  const q = (query.get('q') || '').toLowerCase();
  if (p === '/health') return { ok: true, database: { ok: true }, rndc: { ambiente: 'pruebas', envioHabilitado: false } };
  if (p === '/auth/me') return { user: USER };
  if (p === '/stats') return STATS;
  if (p === '/cola/resumen') return { pendiente: 4, enviando: 1, error: 1 };
  if (p.endsWith('/resumen')) return { pendientes: p.includes('despachos') ? 2 : 1 };
  if (p === '/chat/estado') return { habilitado: false };
  if (p === '/catalogos/empaques') return [{ codigo: '0', descripcion: 'Granel' }, { codigo: '1', descripcion: 'Bultos' }, { codigo: '2', descripcion: 'Cajas' }];
  if (p === '/terceros/buscar') return TERCEROS.filter((t) => !q || t.nombre.toLowerCase().includes(q) || t.num_id.includes(q)).map((t) => ({ ...t, label: `${t.nombre} (${t.tipo_id} ${t.num_id})` }));
  if (p === '/municipios/buscar') return [{ label: 'Medellín – Medellín, Antioquia', codigo_rndc: '05001000' }, { label: 'Barranquilla – Barranquilla, Atlántico', codigo_rndc: '08001000' }];
  if (p === '/productos/buscar') return PRODUCTOS.filter((x) => !q || x.nombre.toLowerCase().includes(q)).map((x) => ({ ...x, label: `${x.codigo} - ${x.nombre}` }));
  if (p === '/vehiculos/buscar') return VEHICULOS.filter((v) => !q || v.placa.toLowerCase().includes(q)).map((v) => ({ ...v, label: v.placa }));
  if (p === '/vehiculos/detalle') return { ...VEHICULOS[0], conductor_tipo_id: 'C', conductor_num_id: '70100200', conductor_nombre_completo: 'CARLOS MENDOZA ROJAS', tenedor_tipo_id: 'N', tenedor_num_id: '900100200', tenedor_nombre_completo: 'AGROINDUSTRIAL EL PALMAR S.A.S.' };
  if (p === '/solicitudes') return paged(SOLICITUDES, 35);
  if (/^\/solicitudes\/\d+$/.test(p)) {
    return {
      solicitud: SOL,
      manifiesto: { id: 199, num_manifiesto: '0100001239', placa_vehiculo: 'DEM456', estado_rndc: 'aceptado', rndc_ingreso_id: '118000412', valor_flete_pactado: 5200000, valor_anticipo: 3640000 },
      remesas: [{ id: 301, num_remesa: '010120033', descripcion_producto: 'ACEITE DE PALMA CRUDO', peso: 17000, estado_rndc: 'aceptado' }],
    };
  }
  if (p === '/despachos') return paged(DESPACHOS, 6);
  if (p === '/cola') return { filas: COLA, resumen: { pendiente: 4, enviando: 1, enviado: 18, error: 1 }, proceso: query.get('proceso') || 'todos', envioHabilitado: false, ambiente: 'pruebas' };
  if (p === '/cumplido') return CUMPLIDO;
  if (p === '/informe') return INFORME;
  if (p === '/terceros') return paged(TERCEROS, 6);
  if (p === '/vehiculos') return paged(VEHICULOS, 3);
  if (p === '/productos') return paged(PRODUCTOS, 4);
  if (p === '/empresa') return EMPRESA;
  if (p === '/usuarios') return USUARIOS;
  return {};
}

// ---------------------------------------------------------------------------
// Capturas
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser, { width = 1280, height = 800, theme = 'light', auth = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1.5 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.evaluateOnNewDocument((u, a, t) => {
    localStorage.setItem('konekto-theme', t);
    if (a) localStorage.setItem('tms-auth', JSON.stringify({ state: { token: 'demo', user: u }, version: 0 }));
    else localStorage.removeItem('tms-auth');
  }, USER, auth, theme);
  // En pestañas en segundo plano requestAnimationFrame se pausa y los gráficos (Recharts) quedan vacíos.
  await page.evaluateOnNewDocument(() => {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return r.continue();
    r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(api(u.pathname, u.searchParams)) });
  });
  return page;
}

/** Espera a que Recharts dibuje las barras (el panel) antes de capturar. */
async function esperarGraficos(page) {
  await page.waitForSelector('.recharts-rectangle', { timeout: 15000 });
  await sleep(1800);
}

async function go(page, route, wait = 700) {
  await page.goto(BASE + route, { waitUntil: 'networkidle0' });
  await page.bringToFront(); // las animaciones de Recharts no avanzan en pestañas ocultas
  await sleep(wait);
}

/** Pone círculos numerados en la esquina de elementos (selector CSS + texto opcional). at: 'l' izquierda (por defecto) o 'r' derecha. */
async function marcar(page, lista) {
  const faltan = await page.evaluate((lista) => {
    const faltan = [];
    for (const c of lista) {
      const els = [...document.querySelectorAll(c.sel)];
      const el = c.text ? els.find((e) => (e.textContent || '').trim().toLowerCase().includes(c.text.toLowerCase())) : els[c.idx || 0];
      if (!el) { faltan.push(`${c.n}:${c.sel}:${c.text || ''}`); continue; }
      const r = el.getBoundingClientRect();
      const d = document.createElement('div');
      d.textContent = String(c.n);
      const x = window.scrollX + (c.at === 'r' ? r.right - 11 : r.left - 11) + (c.dx || 0);
      const y = window.scrollY + r.top - 11;
      d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:22px;height:22px;border-radius:50%;background:#F5A623;color:#142B54;font:700 12px/22px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.45);z-index:99999`;
      document.body.appendChild(d);
    }
    return faltan;
  }, lista);
  if (faltan.length) console.warn('  ! no se encontró:', faltan.join(' | '));
}

const jpg = async (page, opts = {}) => `data:image/jpeg;base64,${Buffer.from(await page.screenshot({ type: 'jpeg', quality: 88, ...opts })).toString('base64')}`;

const SIDEBAR = 256;

/** Recorta solo el área de contenido (sin barra lateral ni cabecera) para que el texto salga más grande. */
async function contenido(page, vw, alto, x0 = SIDEBAR, ancho) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const hh = await page.evaluate(() => Math.ceil(document.querySelector('header').getBoundingClientRect().bottom));
  const total = alto || (await page.evaluate(() => document.documentElement.scrollHeight));
  return jpg(page, { clip: { x: x0, y: hh, width: ancho || vw - x0, height: Math.max(120, total - hh) }, captureBeyondViewport: true });
}

async function capturar(browser) {
  const S = {};
  const W = 1440;

  // 1) Login (sin sesión)
  let page = await newPage(browser, { width: 1000, height: 640, auth: false });
  await go(page, '/login');
  S.login = await jpg(page);
  await page.close();

  // 2) Panel (con la barra lateral y la cabecera completas)
  page = await newPage(browser, { width: 1280 });
  await go(page, '/', 300);
  await esperarGraficos(page);
  await marcar(page, [
    { n: 1, sel: 'aside nav a', text: 'Inicio', at: 'r' },
    { n: 2, sel: '.card', idx: 0 },
    { n: 3, sel: '.card', text: 'Cola de envíos por estado' },
    { n: 4, sel: 'header button[title^="Cambiar a tema"]' },
    { n: 5, sel: '.card', text: 'Ambiente RNDC' },
  ]);
  S.home = await jpg(page, { clip: { x: 0, y: 0, width: 1280, height: 800 }, captureBeyondViewport: false });
  await page.close();

  // 3) Solicitudes: lista
  page = await newPage(browser, { width: W });
  await go(page, '/solicitudes');
  await marcar(page, [
    { n: 1, sel: 'a', text: 'Nueva solicitud' },
    { n: 2, sel: 'form input', idx: 0, at: 'r' },
    { n: 3, sel: 'thead th', text: 'Estado' },
    { n: 4, sel: 'tbody tr:nth-child(3) a', idx: 0 },
  ]);
  S.solicitudes = await contenido(page, W, 560);
  await page.close();

  // 4) Nueva solicitud (formulario completo, relleno tecleando como un usuario)
  page = await newPage(browser, { width: 1280, height: 900 });
  await go(page, '/solicitudes/nueva');
  const buscar = async (selector, indice, texto) => {
    const els = await page.$$(selector);
    await els[indice].click();
    await els[indice].type(texto, { delay: 15 });
    await sleep(600);
    await page.click('ul li button');
    await sleep(200);
  };
  await buscar('input[placeholder^="Nombre, apellido"]', 0, 'agro');
  await buscar('input[placeholder^="Nombre, apellido"]', 1, 'distri');
  await buscar('input[placeholder^="Nombre, apellido"]', 2, 'agro');
  await buscar('input[placeholder^="Buscar producto"]', 0, 'aceite');
  await fill(page, 'Peso (kg)', '34000');
  await fill(page, 'Cantidad vehículos', '2');
  await fill(page, 'Valor del flete', '5200000');
  await fill(page, 'Tarifa ICA', '6');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(400);
  await marcar(page, [
    { n: 1, sel: 'label', text: 'Operación de transporte', dx: -26 },
    { n: 2, sel: 'label', text: 'Remitente', dx: -26 },
    { n: 3, sel: 'label', text: 'Producto / mercancía', dx: -26 },
    { n: 4, sel: 'label', text: 'Valor del flete', dx: -26 },
    { n: 5, sel: 'label', text: 'Retención ICA', dx: -26 },
  ]);
  S.nueva = await contenido(page, 1280, 0, SIDEBAR + 128, 768);
  await page.close();

  // 5) Detalle de solicitud
  page = await newPage(browser, { width: W });
  await go(page, '/solicitudes/1046');
  await marcar(page, [
    { n: 1, sel: 'a', text: 'Confirmar despacho' },
    { n: 2, sel: 'button', text: 'Manifiesto PDF' },
    { n: 3, sel: 'button', text: 'PDF RNDC' },
    { n: 4, sel: 'dt', text: 'Peso' },
  ]);
  S.detalle = await contenido(page, W, 800);
  await page.close();

  // 6) Confirmar despacho
  page = await newPage(browser, { width: 1280, height: 900 });
  await go(page, '/solicitudes/1046/despachar');
  await page.click('input[placeholder^="Buscar placa"]');
  await page.type('input[placeholder^="Buscar placa"]', 'DEM', { delay: 20 });
  await sleep(600);
  await page.click('ul li button');
  await sleep(600);
  await fill(page, 'Peso (kg)', '17000');
  await fill(page, 'Valor del anticipo', '3640000');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(400);
  await marcar(page, [
    { n: 1, sel: 'label', text: 'Vehículo (placa)', dx: -26 },
    { n: 2, sel: 'label', text: 'Conductor', dx: -26 },
    { n: 3, sel: 'label', text: 'Valor del anticipo', dx: -26 },
    { n: 4, sel: 'legend', text: 'Remesas del despacho', dx: -26 },
    { n: 5, sel: 'label', text: 'Peso (kg)', dx: -26 },
  ]);
  S.despachar = await contenido(page, 1280, 0, SIDEBAR + 128, 768);
  await page.close();

  // 7) Despachos
  page = await newPage(browser, { width: W });
  await go(page, '/despachos');
  await marcar(page, [
    { n: 1, sel: 'tbody tr:nth-child(1) button[title="PDF Manifiesto"]' },
    { n: 2, sel: 'tbody tr:nth-child(1) button[title="PDF Remesa"]' },
    { n: 3, sel: 'tbody tr:nth-child(1) button[title^="PDF oficial"]' },
    { n: 4, sel: 'tbody tr:nth-child(4) button[title^="PDF oficial"]' },
    { n: 5, sel: 'thead th', text: 'RNDC' },
  ]);
  S.despachos = await contenido(page, W, 470);
  await page.close();

  // 8) Cola
  page = await newPage(browser, { width: W });
  await go(page, '/cola');
  await marcar(page, [
    { n: 1, sel: 'strong', idx: 0, at: 'r', dx: 6 },
    { n: 2, sel: 'thead th', text: 'Categoría' },
    { n: 3, sel: 'thead th', text: 'Estado' },
    { n: 4, sel: 'thead th', text: 'Último mensaje' },
    { n: 5, sel: 'button', text: 'Procesar ahora' },
  ]);
  S.cola = await contenido(page, W, 660);
  await page.close();

  // 9) Cumplido + Informe
  page = await newPage(browser, { width: W });
  await go(page, '/cumplido');
  await marcar(page, [{ n: 1, sel: 'tbody tr:nth-child(1) a', idx: 0 }]);
  S.cumplido = await contenido(page, W, 360);
  await go(page, '/informe');
  await marcar(page, [{ n: 1, sel: 'button', text: 'CSV' }, { n: 2, sel: 'button', text: 'Por remesa' }]);
  S.informe = await contenido(page, W, 640);
  await page.close();

  // 10) Maestros y administración
  page = await newPage(browser, { width: W });
  for (const [k, ruta, h] of [['terceros', '/terceros', 440], ['vehiculos', '/vehiculos', 390], ['productos', '/productos', 470], ['empresa', '/empresa', 720], ['usuarios', '/usuarios', 360]]) {
    await go(page, ruta);
    S[k] = k === 'empresa' ? await contenido(page, W, h, SIDEBAR + Math.round((W - SIDEBAR - 768) / 2), 768) : await contenido(page, W, h);
  }
  await page.close();

  // 11) Tema oscuro y móvil
  page = await newPage(browser, { theme: 'dark', width: 1280 });
  await go(page, '/', 300);
  await esperarGraficos(page);
  S.oscuro = await jpg(page, { clip: { x: 0, y: 0, width: 1280, height: 600 }, captureBeyondViewport: false });
  await page.close();
  page = await newPage(browser, { width: 390, height: 780 });
  await go(page, '/', 300);
  await esperarGraficos(page);
  S.movil = await jpg(page);
  await page.close();

  return S;
}

/** Escribe en el input que sigue a una etiqueta (por su texto). */
async function fill(page, label, value) {
  const h = await page.evaluateHandle((label) => {
    const l = [...document.querySelectorAll('label.field-label')].find((x) => x.textContent.trim().startsWith(label));
    return l ? l.parentElement.querySelector('input') : null;
  }, label);
  const el = h.asElement();
  if (el) { await el.click({ clickCount: 3 }); await el.type(String(value), { delay: 10 }); }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
const MARK = `<svg viewBox="0 0 100 100" width="MARKPX" height="MARKPX"><path d="M2 8H26L56 50L26 92H2L32 50Z" fill="#142B54"/><path d="M26 8H40L70 50H56Z" fill="#09B8CD"/><path d="M56 50H70L40 92H26Z" fill="#0580A1"/><g fill="none" stroke="#142B54" stroke-width="9" stroke-linejoin="round"><path d="M99 50H82M82 50C74 50 72 41 66 38M82 50C74 50 72 59 66 62"/></g><g fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="4 3"><path d="M98 50H82M82 50C74 50 72 41 67 38.5M82 50C74 50 72 59 67 61.5"/></g><path d="M60 36C64 24 72 18 84 18" stroke="#09B8CD" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M60 64C64 76 72 82 84 82" stroke="#11B787" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="88" cy="18" r="10" fill="#09B8CD"/><circle cx="88" cy="18" r="4.5" fill="#142B54"/><circle cx="88" cy="82" r="10" fill="#11B787"/><circle cx="88" cy="82" r="4.5" fill="#142B54"/></svg>`;
const mark = (px) => MARK.replace(/MARKPX/g, String(px));
const wordmark = (cls = '') => `<span class="wm ${cls}">konek<span class="to">to</span></span>`;
const img = (src, cls = '') => `<img class="shot ${cls}" src="${src}" alt="">`;
const lista = (items) => `<ol class="leyenda">${items.map((t, i) => `<li><b>${i + 1}</b><span>${t}</span></li>`).join('')}</ol>`;

function pagina(n, titulo, cuerpo) {
  return `<section class="pag">
    <header class="top"><span class="brand">${mark(22)} ${wordmark()}</span><span class="lema">Despacho &amp; RNDC Light</span></header>
    <h2>${titulo}</h2>${cuerpo}
    <footer>Capturas con datos de demostración · Konekto · Manual rápido <span>${n}</span></footer>
  </section>`;
}

function html(S) {
  const paginas = [];
  let n = 2;
  const add = (t, c) => paginas.push(pagina(n++, t, c));

  add('¿Qué es Konekto?', `
    <p class="lead">Konekto es el sistema de despachos de carga que conecta tu operación diaria con el <b>RNDC</b> (Registro Nacional de Despachos de Carga): capturas la solicitud una sola vez y la plataforma arma, envía y da seguimiento a la remesa y al manifiesto.</p>
    <div class="flujo">
      <div class="paso"><b>1</b><h4>Solicitud</h4><p>Se captura una sola vez: partes, carga y valores.</p></div><i>→</i>
      <div class="paso"><b>2</b><h4>Confirmar despacho</h4><p>Vehículo, conductor y remesas. Se generan manifiesto y remesas.</p></div><i>→</i>
      <div class="paso"><b>3</b><h4>Cola de envíos</h4><p>Se envían al RNDC en el orden correcto, con reintentos.</p></div><i>→</i>
      <div class="paso"><b>4</b><h4>Cumplido</h4><p>Cierre del viaje: cumplido de remesa y de manifiesto.</p></div>
    </div>
    <h3>Lo que te resuelve</h3>
    <ul class="checks">
      <li><b>Una sola captura.</b> De la solicitud salen el manifiesto y las remesas; las retenciones (ICA, fuente, FOPAT) se calculan solas.</li>
      <li><b>Envío ordenado y seguro.</b> Terceros → vehículo → remesa → manifiesto. Si el RNDC no responde, la cola reintenta; existe un modo seguro para practicar sin enviar nada real.</li>
      <li><b>Documentos listos.</b> PDF de manifiesto y remesa con código QR, y el PDF oficial del RNDC una vez aceptado el manifiesto.</li>
      <li><b>Control.</b> Panel con indicadores, informe filtrable con descarga en CSV, roles de administrador y operador con permisos por módulo.</li>
      <li><b>Cómodo de usar.</b> Funciona en computador y celular, con tema claro u oscuro y notificaciones opcionales.</li>
    </ul>`);

  add('Ingreso y panel de control', `
    <p>Ingresa con tu correo y contraseña. El panel muestra el estado de tu operación de un vistazo.</p>
    ${img(S.login, 'w70')}
    ${img(S.home)}
    ${lista(['Menú lateral: cada módulo; los globos rojos avisan cuántos pendientes hay.', 'Indicadores: solicitudes, manifiestos y cola con pendientes o con error.', 'Gráficos: estado de la cola y despachos de los últimos 14 días.', 'Cambio de tema claro/oscuro, notificaciones y cierre de sesión.', 'Ambiente del RNDC y modo de envío (seguro o real).'])}`);

  add('Solicitudes de servicio', `
    <p>Aquí empieza todo. Busca por consecutivo, filtra por fechas y revisa el estado de cada solicitud: <i>borrador</i>, <i>procesada</i> (con vehículos pendientes) o <i>despachada</i>.</p>
    ${img(S.solicitudes)}
    ${lista(['Crea una nueva solicitud.', 'Busca por consecutivo y filtra por rango de fechas.', 'El estado indica cuánto falta por despachar (la columna Despachos muestra los vehículos ya asignados).', 'Abre el detalle para ver manifiesto, remesas y documentos.'])}`);

  add('Crear una solicitud', `
    <p>Un solo formulario con la información del servicio. Las retenciones se calculan automáticamente a partir del flete: no hay que digitarlas.</p>
    <div class="cols">${img(S.nueva, 'tall')}${lista(['Operación de transporte (general, paqueteo o contenedor; en contenedor se pide el serial de 11 caracteres).', 'Remitente, destinatario y generador: se buscan por nombre o identificación.', 'Producto de la mercancía y su empaque; las cargas peligrosas se validan.', 'Valor del flete y tarifa ICA.', 'Retenciones calculadas automáticamente.'])}</div>`);

  add('Detalle y documentos de la solicitud', `
    <p>El detalle reúne los datos generales, el manifiesto con su estado ante el RNDC y las remesas. Desde aquí se confirma el despacho cuando aún quedan vehículos por asignar y se descargan los PDF.</p>
    ${img(S.detalle)}
    ${lista(['Confirmar despacho: asigna vehículo y conductor.', 'PDF del manifiesto y de la remesa generados por Konekto, con QR.', 'PDF oficial entregado por el RNDC (se habilita cuando el manifiesto es aceptado).', 'Peso despachado frente al peso total: el sistema evita asignar de más.'])}`);

  add('Confirmar despacho', `
    <p>Elige la placa y Konekto trae al conductor y al tenedor. Luego define quién paga cargue y descargue, el anticipo y las remesas del viaje.</p>
    <div class="cols">${img(S.despachar, 'tall')}${lista(['Vehículo: busca por placa.', 'Conductor y tenedor se completan solos.', 'Anticipo y responsables de pago.', 'Una o varias remesas por despacho.', 'Peso de cada remesa, validado contra el disponible.'])}</div>`);

  add('Despachos', `
    <p>El listado de despachos con su estado ante el RNDC, el acceso a los documentos y, para administradores, el envío inmediato y la anulación.</p>
    ${img(S.despachos)}
    ${lista(['PDF del manifiesto.', 'PDF de la remesa.', 'PDF oficial del RNDC, disponible cuando el manifiesto está aceptado.', 'Antes de la aceptación el botón se ve deshabilitado.', 'Estado ante el RNDC: pendiente, enviado, aceptado o rechazado.'])}`);

  add('Cola de envíos al RNDC', `
    <p>Los documentos se envían en el orden que exige el RNDC. Si algo falla o el servicio no responde, la cola lo reintenta y te muestra el motivo para corregirlo.</p>
    ${img(S.cola)}
    ${lista(['Resumen por estado: pendiente, enviando, enviado y error.', 'Categoría: maestro, despacho, cumplido o anulación.', 'Estado de cada envío, con el número de ingreso que devuelve el RNDC.', 'Último mensaje: te dice qué corregir cuando hay un error.', 'Procesar ahora (administradores): envía lo pendiente cuando el envío real está habilitado.'])}`);

  add('Cumplido e informe', `
    <p>Al terminar el viaje se registra el cumplido de remesas y manifiesto. El informe permite consultar y exportar la operación.</p>
    ${img(S.cumplido)}
    ${lista(['Abre el despacho para registrar su cumplido.'])}
    ${img(S.informe)}
    ${lista(['Descarga el informe en CSV con los filtros aplicados.', 'Cambia entre detalle por remesa y resumen por manifiesto.'])}`);

  add('Maestros', `
    <p>Los datos base de la operación se administran en un solo lugar y se registran en el RNDC desde la misma pantalla.</p>
    <figure>${img(S.terceros)}<figcaption>Terceros: remitentes, destinatarios, propietarios y conductores, con su estado de registro en el RNDC.</figcaption></figure>
    <figure>${img(S.vehiculos)}<figcaption>Vehículos con su configuración, remolque y tenedor.</figcaption></figure>
    <figure>${img(S.productos)}<figcaption>Productos: catálogo de mercancías, con código UN y estado para cargas peligrosas.</figcaption></figure>`);

  add('Empresa y usuarios', `
    <p>La administración de la empresa y de quién puede hacer qué.</p>
    <figure>${img(S.empresa)}<figcaption>Empresa: datos, pólizas, consecutivos y credenciales del RNDC (solo administradores; nunca se muestran en los listados).</figcaption></figure>
    <figure>${img(S.usuarios)}<figcaption>Usuarios: rol de administrador u operador y permisos por módulo.</figcaption></figure>`);

  add('Pensado para el día a día', `
    <figure>${img(S.oscuro)}<figcaption><b>Tema oscuro</b> para turnos nocturnos: sigue la preferencia del equipo o se cambia con un clic.</figcaption></figure>
    <div class="grid2 centro">
      <figure>${img(S.movil, 'phone')}<figcaption><b>En el celular</b>, con la misma información y notificaciones cuando algo requiere atención.</figcaption></figure>
      <div>
        <h3>Seguridad y control</h3>
        <ul class="checks">
          <li>Cada persona entra con su usuario; los permisos se asignan por módulo.</li>
          <li>El envío real al RNDC está restringido a administradores y protegido por un interruptor de seguridad.</li>
          <li>Las credenciales del RNDC se guardan en la configuración de la empresa.</li>
        </ul>
      </div>
    </div>`);

  const portada = `<section class="pag portada">
    <div class="logo">${mark(150)}</div>
    <h1>${wordmark('big')}</h1>
    <p class="tag">Despacho &amp; RNDC Light</p>
    <div class="linea"></div>
    <h3>Manual rápido</h3>
    <p class="sub">Registra, despacha y cumple ante el RNDC desde un solo lugar.</p>
    <footer>Documento de presentación · capturas con datos de demostración</footer>
  </section>`;

  return `<!doctype html><html lang="es"><meta charset="utf-8"><style>
    @page { size: A4; margin: 0 }
    * { box-sizing: border-box }
    body { margin: 0; font: 11pt/1.45 "Segoe UI", system-ui, Roboto, Arial, sans-serif; color: #1e293b }
    .pag { width: 210mm; height: 297mm; padding: 16mm 16mm 14mm; page-break-after: always; position: relative; overflow: hidden }
    .top { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 10px }
    .brand { display: flex; align-items: center; gap: 8px; font-size: 14pt }
    .brand svg { display: block }
    .lema { color: #64748b; font-size: 9pt; letter-spacing: .05em; text-transform: uppercase }
    .wm { font-weight: 800; letter-spacing: -.02em; color: #142B54 } .wm .to { color: #09B8CD } .wm.big { font-size: 56pt }
    h2 { margin: 6px 0 8px; font-size: 19pt; color: #142B54 }
    h3 { margin: 14px 0 6px; font-size: 12.5pt; color: #0580A1 }
    p { margin: 0 0 8px } .lead { font-size: 11.5pt }
    .shot { display: block; width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; margin: 8px 0 }
    .shot.w70 { width: 62%; margin-left: auto; margin-right: auto }
    .shot.tall { width: auto; max-width: 118mm; max-height: 212mm; margin: 0 }
    .cols { display: flex; gap: 8mm; align-items: flex-start }
    .cols .leyenda { grid-template-columns: 1fr; gap: 9px; margin-top: 8px; font-size: 10pt }
    .shot.phone { width: 52%; margin-left: auto; margin-right: auto }
    .leyenda { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 5px 14px; font-size: 9.5pt }
    .leyenda li { display: flex; gap: 7px; align-items: flex-start }
    .leyenda b { flex: none; width: 17px; height: 17px; border-radius: 50%; background: #F5A623; color: #142B54; text-align: center; font-size: 8.5pt; line-height: 17px }
    .flujo { display: flex; align-items: stretch; gap: 6px; margin: 12px 0 }
    .flujo i { align-self: center; font-style: normal; color: #09B8CD; font-weight: 700; font-size: 16pt }
    .paso { flex: 1; border: 1px solid #cbd5e1; border-radius: 10px; padding: 9px 10px; background: #f8fafc }
    .paso b { display: inline-block; width: 20px; height: 20px; border-radius: 50%; background: #142B54; color: #fff; text-align: center; line-height: 20px; font-size: 9pt }
    .paso h4 { margin: 5px 0 2px; font-size: 10.5pt; color: #142B54 } .paso p { font-size: 8.8pt; margin: 0; color: #475569 }
    .checks { padding-left: 0; list-style: none } .checks li { padding-left: 18px; position: relative; margin-bottom: 6px }
    .checks li::before { content: "✓"; position: absolute; left: 0; color: #11B787; font-weight: 700 }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px } .grid2 figure { margin: 0 }
    .grid2 figcaption { font-size: 9pt; color: #475569; margin-top: -2px }
    figure { margin: 0 0 6px } figcaption { font-size: 9pt; color: #475569; margin-top: -2px } .grid2.centro { align-items: start }
    footer { position: absolute; left: 16mm; right: 16mm; bottom: 8mm; font-size: 8pt; color: #94a3b8; display: flex; justify-content: space-between; border-top: 1px solid #e2e8f0; padding-top: 5px }
    .portada { background: #142B54; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center }
    .portada .wm { color: #fff } .portada .logo { margin-bottom: 14px }
    .portada .tag { letter-spacing: .3em; text-transform: uppercase; color: #9fb3d6; font-size: 11pt; margin: 4px 0 0 }
    .portada .linea { width: 70px; height: 3px; background: #09B8CD; margin: 30px 0 }
    .portada h3 { color: #fff; font-size: 20pt; margin: 0 } .portada .sub { color: #cbd5e1; font-size: 12pt; max-width: 110mm }
    .portada footer { color: #7f94ba; border-color: #2c4577; justify-content: center }
  </style><body>${portada}${paginas.join('')}</body></html>`;
}

(async () => {
  if (!CHROME) throw new Error('No se encontró Chrome/Edge. Define CHROME_PATH.');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--lang=es-CO'] });
  try {
    console.log('Capturando pantallas…');
    const S = await capturar(browser);
    const page = await browser.newPage();
    await page.setContent(html(S), { waitUntil: 'load' });
    if (process.env.PREVIEW_DIR) {
      // Revisión visual: una imagen por página del manual.
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1.2 });
      const pags = await page.$$('.pag');
      for (let i = 0; i < pags.length; i++) await pags[i].screenshot({ path: path.join(process.env.PREVIEW_DIR, `p${String(i + 1).padStart(2, '0')}.png`) });
    }
    const pdf = path.join(OUT, 'Konekto-Manual-Rapido.pdf');
    await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
    console.log('Listo:', pdf);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
