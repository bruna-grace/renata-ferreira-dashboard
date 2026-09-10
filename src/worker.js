/**
 * Worker do dashboard da Dra. Renata Ferreira.
 *
 *  - Serve o dashboard (public/index.html, static assets)
 *  - GET  /api/crm       → leads do WaSeller já agregados por contato × mês
 *  - POST /api/crm/sync  → roda um passo de sincronização na hora (exige SYNC_TOKEN)
 *  - Cron a cada 5 min   → lê as linhas novas da aba WaSeller_Log e atualiza o KV
 *
 * Por que incremental: WaSeller_Log é o log CRU do webhook (payload inteiro,
 * inclusive mídia em base64). Passa de 10 MB e cresce ~130 linhas/dia.
 * Parsear tudo a cada request estoura os 10 ms de CPU do plano Free. O cron lê
 * no máximo CHUNK linhas por vez, a partir de um cursor de data, e acumula o
 * estado por contato no KV. O GET só lê esse estado (~0 CPU).
 *
 * Privacidade: a API NÃO devolve nome, telefone nem texto de mensagem — só uma
 * chave anônima (hash dos 8 últimos dígitos, usada p/ deduplicar com as abas
 * manuais), origem, status e data. É tudo o que o dashboard usa.
 */

const SHEET_ID = '1UnpShR1ydhFy-4dKDdQLJFSEjXxf1IKmQ_YmlSQxLcQ';  // planilha "CRM - Renata"
const LOG_GID  = '1469639904';                                     // aba WaSeller_Log
const DESDE    = '2026-09';   // 1º mês servido pelo WaSeller (antes disso: abas manuais)
const CHUNK    = 250;         // linhas por passo de sync (limita a CPU por execução)
const STATE_KEY = 'waseller:state:v2';

/* Filtro aplicado PELO GOOGLE antes de mandar os dados: descarta payload de
   teste, grupo, status e mensagem com mídia (são ~60% dos bytes do log e não
   trazem nada que as outras linhas do mesmo contato não tragam). */
const FILTRO = `C starts with '{"name"' and not C contains '@g.us'` +
               ` and not C contains '"number":"status"' and not C contains '"mimetype"'`;

/* ── Mapeamento etiqueta WaSeller → vocabulário do dashboard ──────────────
   Comparação sem acento e sem caixa. Etiquetas operacionais ("Não lidas",
   "INCLUIR NO CRM - MENSAL", "CONTATOS 2026") e de região ("NOVO-SP",
   "OUTRA CIDADE") não mexem em origem nem status. */

/* PRÉVIA de conversão = "1º CONSULTA" ou "agendamento concluído". A conversão
   oficial é o nº de consultas realizadas que a Renata informa (aba CONSULTAS,
   lida pelo dashboard); isto aqui é o que o CRM consegue antecipar no mês.
   Conta no mês em que a etiqueta foi ADICIONADA — etiqueta é estado permanente
   no WaSeller, e um paciente de julho que manda mensagem em setembro continua
   com "1º CONSULTA". Sem isso, setembro contaria conversões de meses passados. */
const ehConversao = l => /^1.? ?consulta/.test(l) || (l.includes('agendamento') && l.includes('conclu'));

/* Demais status: a PRIMEIRA regra que bater vence (ordem = prioridade). */
const STATUS_REGRAS = [
  ['Paciente',              ehConversao],   // já convertido em mês anterior
  ['Declinado',             l => l.startsWith('declin')],
  ['Desmarcou',             l => l.startsWith('desmarc')],
  ['Follow',                l => l === 'acompanhar' || l.startsWith('follow')],
  ['Paciente',              l => l === 'pacientes' || l === 'paciente'],
  ['Atendimento iniciado',  l => l.startsWith('flow')],   // "Flow 1" = entrou na automação
];

function origemDe(etiquetas) {
  for (const l of etiquetas) {
    if (l.includes('youtube'))   return 'YouTube';
    if (l.includes('instagram')) return 'Instagram';
    if (l.includes('google'))    return 'Google';
    if (/\bsite\b/.test(l))      return 'Site';
    if (l.includes('indica') || l.includes('dr.') || l.includes('dra.')) return 'Indicação';
  }
  return 'Não informado';
}

function statusDe(etiquetas, convertiuNoMes) {
  if (convertiuNoMes) return 'Agendamento concluído';
  for (const [status, bate] of STATUS_REGRAS) if (etiquetas.some(bate)) return status;
  return 'Sem status';
}

const nomesEtiquetas = lista => (Array.isArray(lista) ? lista : []).map(l => simplificar(l?.name));
const simplificar = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/* ── HTTP + cron ─────────────────────────────────────────────────────────── */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/api/crm' && req.method === 'GET') {
      const estado = await env.CRM.get(STATE_KEY, 'json');
      return json(montarResposta(estado), { 'Cache-Control': 'public, max-age=60' });
    }

    if (url.pathname === '/api/crm/sync' && req.method === 'POST') {
      if (!env.SYNC_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.SYNC_TOKEN}`) {
        return json({ erro: 'não autorizado' }, {}, 401);
      }
      return json(await sincronizar(env));
    }

    return env.ASSETS.fetch(req);
  },

  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(sincronizar(env).then(r => console.log('sync', JSON.stringify(r))));
  },
};

function json(obj, headers = {}, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/* ── Sincronização incremental ───────────────────────────────────────────── */

async function sincronizar(env) {
  const estado = (await env.CRM.get(STATE_KEY, 'json')) || { v: 1, cursor: null, contatos: {} };
  const linhas = await lerLog(estado.cursor);

  const antes = JSON.stringify(estado.contatos);
  let cursor = estado.cursor;
  const chaves = new Map();  // telefone → hash (evita recalcular dentro do lote)

  for (const { ts, cru } of linhas) {
    if (!cursor || ts > cursor) cursor = ts;
    if (ts.slice(0, 7) < DESDE) continue;

    const p = lerPayload(cru);
    const num = String(p?.number || '');
    const m = num.match(/^(\d+)@(c\.us|lid)$/);
    if (!m) continue;

    if (!chaves.has(m[1])) chaves.set(m[1], await hashTelefone(m[1]));
    const k = chaves.get(m[1]);
    if (!k) continue;

    const etiquetas = nomesEtiquetas(p.labels).filter(l => l && l !== 'nao lidas');
    const novoUsuario = cru.includes('"NewUser"');
    /* evento "labels"/"add" diz exatamente quais etiquetas entraram agora */
    let adicionadas = [];
    if (p.eventID === 'labels') {
      const det = lerPayloadCompleto(cru)?.eventDetails;
      if (det?.type === 'add') adicionadas = nomesEtiquetas(det.labels);
    }

    registrar(estado, k, ts, etiquetas, novoUsuario, adicionadas);
  }

  /* Lote cheio = ainda há histórico por ler; o próximo passo continua dali. */
  const sincronizando = linhas.length >= CHUNK;
  if (sincronizando && cursor === estado.cursor) {
    console.error(`cursor preso em ${cursor}: mais de ${CHUNK} linhas no mesmo segundo`);
  }

  /* só grava se algo mudou — o KV grátis aceita 1.000 escritas/dia e o cron
     roda 288x/dia; a borda do cursor (>=) é relida toda vez */
  const grava = JSON.stringify(estado.contatos) !== antes
             || cursor !== estado.cursor || estado.sincronizando !== sincronizando;
  if (grava) {
    estado.cursor = cursor;
    estado.sincronizando = sincronizando;
    estado.atualizadoEm = new Date().toISOString();
    await env.CRM.put(STATE_KEY, JSON.stringify(estado));
  }

  return { lidas: linhas.length, gravou: grava, cursor, sincronizando, contatos: Object.keys(estado.contatos).length };
}

/* Um contato por mês. Status do mês = etiquetas do ÚLTIMO evento daquele mês;
   data = primeiro evento do mês. Idempotente: reprocessar a mesma linha (o
   cursor usa >=) não altera nada.

   Conversão (cv) = a etiqueta de conversão ENTROU neste mês: ou o evento diz
   que ela foi adicionada, ou o evento anterior do contato não a tinha e este
   tem. Quem já aparece com ela no 1º evento visto converteu antes do webhook
   existir → não é conversão do mês (vira "Paciente"). c._ guarda o estado de
   conversão no último evento visto, p/ comparar com o próximo. */
function registrar(estado, k, ts, etiquetas, novoUsuario, adicionadas) {
  const mes = ts.slice(0, 7);
  const c = (estado.contatos[k] ||= {});

  const temConv = etiquetas.some(ehConversao);
  const meta = (c._ ||= { t: '', cv: null });
  let converteu = adicionadas.some(ehConversao);
  if (ts >= meta.t) {
    if (meta.cv === false && temConv) converteu = true;
    meta.t = ts; meta.cv = temConv;
  }

  const e = (c[mes] ||= { f: ts, ts, tags: etiquetas });
  if (converteu) e.cv = true;
  if (novoUsuario) e.nu = true;
  if (ts < e.f) e.f = ts;
  /* empate no mesmo segundo: fica o maior JSON — determinístico, não oscila */
  if (ts > e.ts || (ts === e.ts && JSON.stringify(etiquetas) > JSON.stringify(e.tags))) {
    e.ts = ts; e.tags = etiquetas;
  }
}

/* Só o começo do payload interessa (name, labels, number). Corta antes de
   "eventDetails" — é onde mora o grosso (mensagem, mídia) — e parseia o resto.
   Isso também salva as linhas que o Sheets truncou em 45 mil caracteres. */
function lerPayload(cru) {
  const i = cru.indexOf(',"eventDetails":');
  try { return JSON.parse(i > 0 ? cru.slice(0, i) + '}' : cru); } catch {}
  return lerPayloadCompleto(cru);
}

function lerPayloadCompleto(cru) {
  try { return JSON.parse(cru); } catch { return null; }
}

async function lerLog(cursor) {
  const onde = (cursor ? `A >= datetime '${cursor}' and ` : '') + FILTRO;
  const tq = `select A, C where ${onde} order by A limit ${CHUNK}`;
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
              `?tqx=out:json&gid=${LOG_GID}&headers=1&tq=${encodeURIComponent(tq)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets respondeu ${res.status}`);
  const txt = await res.text();
  const dados = JSON.parse(txt.slice(txt.indexOf('(') + 1, txt.lastIndexOf(')')));
  if (dados.status !== 'ok') throw new Error('gviz: ' + JSON.stringify(dados.errors || dados.status));

  const out = [];
  for (const r of dados.table.rows) {
    const ts = dataGviz(r.c[0]?.v);
    const cru = r.c[1]?.v;
    if (ts && cru) out.push({ ts, cru });
  }
  return out;
}

/* "Date(2026,8,3,15,35,2)" → "2026-09-03 15:35:02" (hora local da planilha).
   O formato ordena como texto e é o mesmo que o gviz aceita em datetime '...'. */
function dataGviz(v) {
  const m = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/.exec(v || '');
  if (!m) return null;
  const p = n => String(n).padStart(2, '0');
  return `${m[1]}-${p(+m[2] + 1)}-${p(m[3])} ${p(m[4] || 0)}:${p(m[5] || 0)}:${p(m[6] || 0)}`;
}

/* Mesma função no index.html (crmHashTel): as duas pontas precisam gerar a
   mesma chave p/ um lead das abas manuais bater com o mesmo lead no WaSeller.
   8 últimos dígitos = imune a DDI, DDD e ao 9º dígito. */
async function hashTelefone(tel) {
  const d = String(tel).replace(/\D/g, '');
  if (d.length < 8) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rf:' + d.slice(-8)));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Resposta da API ─────────────────────────────────────────────────────── */

function montarResposta(estado) {
  if (!estado) return { fonte: 'WaSeller_Log', desde: DESDE, sincronizando: true, leads: [] };

  const leads = [];
  for (const [k, meses] of Object.entries(estado.contatos)) {
    for (const [mes, e] of Object.entries(meses)) {
      if (mes === '_') continue;  // metadados do contato, não é mês
      /* contato sem etiqueta nenhuma e sem cadastro no CRM = conversa avulsa
         (sistema, fornecedor, número da própria clínica) — não é lead */
      if (!e.tags.length && !e.nu) continue;
      leads.push({
        k, mes,
        data:   e.f.slice(0, 10),
        origem: origemDe(e.tags),
        status: statusDe(e.tags, e.cv),
      });
    }
  }
  leads.sort((a, b) => a.data < b.data ? -1 : a.data > b.data ? 1 : 0);

  return {
    fonte: 'WaSeller_Log',
    desde: DESDE,
    atualizadoEm: estado.atualizadoEm || null,
    ultimoEvento: estado.cursor,
    sincronizando: !!estado.sincronizando,
    leads,
  };
}
