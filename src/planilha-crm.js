/**
 * Abas manuais do CRM (MAIO/JUNHO/JULHO 26) e aba CONSULTAS.
 *
 * Os parsers abaixo (norm … parseCRMGrid) vieram do index.html SEM mudança de
 * lógica — antes rodavam no navegador, lendo a planilha pública. Agora rodam
 * aqui e o navegador só recebe o resultado anonimizado (sem nome/telefone).
 */
import { consultarPlanilha } from './google.js';
import { chaveTelefone, chaveNome } from './chave.js';

export const PLANILHA_CRM = '1UnpShR1ydhFy-4dKDdQLJFSEjXxf1IKmQ_YmlSQxLcQ';  // "CRM - Renata"

/* CRM contabilizado de Maio/2026 em diante — quando a Renata padronizou a
   metodologia (tag "agendamento concluído"). Meses anteriores usavam outra
   convenção e foram desconsiderados a pedido. De Setembro/2026 em diante o CRM
   vem do WaSeller (worker.js). Não existe aba de Agosto.
   Obs: a aba "FOLLOW MENSAL" é ignorada de propósito — os follow-ups já
   aparecem dentro de cada mês pelo status "Follow" (evita duplicar leads). */
export const ABAS_MANUAIS = ['MAIO 26', 'JUNHO 26', 'JULHO 26'];

/* CONVERSÃO OFICIAL = consultas realizadas no mês, informadas pela Renata:
     Mês     | Consultas realizadas | Observação (opcional)
     09/2026 | 32                   |                         */
const ABA_CONSULTAS = 'CONSULTAS';

export const MESES = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];

/** Leads das abas manuais, anonimizados. Dedupe dentro de cada aba (mesmo lead
    em duas seções da mesma aba conta uma vez), NÃO entre abas. */
export async function lerAbasManuais(env) {
  const leads = [];
  for (const aba of ABAS_MANUAIS) {
    const tabela = await consultarPlanilha(env, { planilha: PLANILHA_CRM, aba, range: 'A:N', headers: 0 });
    const mes = mesDe(aba);
    const vistos = new Set();
    for (const l of parseCRMGrid(gradeDe(tabela))) {
      const data = l.date ? isoData(l.date) : null;
      const k = (await chaveTelefone(l.telefone)) || (await chaveNome(l.nome, data));
      if (vistos.has(k)) continue;
      vistos.add(k);
      leads.push({ k, aba, mes, data, origem: l.origem, status: l.status, convenio: l.convenio, fonte: 'planilha' });
    }
  }
  return leads;
}

/** { 'YYYY-MM': consultas } da aba CONSULTAS. Célula vazia = ainda não informado. */
export async function lerConsultas(env) {
  const tabela = await consultarPlanilha(env, { planilha: PLANILHA_CRM, aba: ABA_CONSULTAS, range: 'A:C', headers: 1 });
  /* aba inexistente → o gviz devolve a PRIMEIRA aba da planilha, sem erro.
     Sem as colunas "Mês" e "Consultas...", não é a aba certa: ignora. */
  const cab = tabela.cols.map(c => norm(c.label || ''));
  const iMes = cab.findIndex(h => h === 'mes' || h.startsWith('mes_'));
  const iNum = cab.findIndex(h => h.startsWith('consultas'));
  if (iMes < 0 || iNum < 0) return {};
  const out = {};
  for (const r of tabela.rows || []) {
    const mes = mesDe(r.c?.[iMes]?.v ?? r.c?.[iMes]?.f);
    const v = r.c?.[iNum]?.v;
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
    if (mes && !isNaN(n)) out[mes] = n;
  }
  return out;
}

/* "09/2026", "9/26", "2026-09", "01/09/2026", "Setembro 2026", "SET/26",
   uma célula de data do gviz, ou o nome de uma aba ("SETEMBRO 26") → "2026-09" */
export function mesDe(v) {
  const p2 = n => String(n).padStart(2, '0');
  const ano = y => y.length === 2 ? '20' + y : y;
  const dg = /^Date\((\d+),(\d+)/.exec(String(v ?? ''));
  if (dg) return `${dg[1]}-${p2(+dg[2] + 1)}`;
  const s = norm(v ?? '');
  let m = s.match(/^(\d{4})_(\d{1,2})$/);                  if (m) return `${m[1]}-${p2(m[2])}`;
  m = s.match(/^(?:\d{1,2}_)?(\d{1,2})_(\d{4}|\d{2})$/);  if (m) return `${ano(m[2])}-${p2(m[1])}`;
  m = s.match(/^([a-z]{3,})_?(\d{4}|\d{2})$/);
  if (m) {
    const i = MESES.findIndex(n => norm(n).startsWith(m[1].slice(0, 3)));
    if (i >= 0) return `${ano(m[2])}-${p2(i + 1)}`;
  }
  return null;
}

/* gviz → grade de células (datas viram "d/m/aaaa", como a planilha mostra) */
function gradeDe(tabela) {
  const nc = tabela.cols.length;
  return (tabela.rows || []).map(r => {
    const arr = [];
    for (let i = 0; i < nc; i++) {
      const cell = (r.c || [])[i];
      if (!cell || cell.v === null || cell.v === undefined) { arr.push(''); continue; }
      const v = cell.v;
      arr.push(typeof v === 'string' && v.startsWith('Date(')
        ? cell.f || v.replace(/Date\((\d+),(\d+),(\d+).*/, (_, y, mo, d) => `${+d}/${+mo + 1}/${y}`)
        : v);
    }
    return arr;
  });
}

const isoData = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* ── Parsers portados do index.html ──────────────────────────────────────── */

function norm(s) {
  return String(s).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[\s\-\/\\]+/g,'_')
    .replace(/[^a-z0-9_]/g,'')
    .replace(/_+/g,'_').replace(/^_|_$/g,'');
}

function parseCRMDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) { const y = +m[3] < 50 ? 2000 + +m[3] : 1900 + +m[3]; return new Date(y, +m[2]-1, +m[1]); }
  return null;
}

function normCRMStatus(raw, isNew) {
  if (!raw) return isNew ? 'Sem status' : 'Não convertido';
  const s = String(raw).trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'');
  if (!isNew) return (s === 'SIM' ? 'Finalizado' : 'Não convertido');
  /* "agendamento concluído" = única tag que conta como conversão real */
  if (s.includes('AGENDAMENTO') && s.includes('CONCLU')) return 'Agendamento concluído';
  if (s.startsWith('AGEN')) return 'Agendado';  // agendamentos pendentes (não é conversão)
  if (s.startsWith('DECL')) return 'Declinado';
  if (s.startsWith('FOL'))  return 'Follow';  // pega "Follow", "Folow" (typo), "Follow Mensal"
  if (s.startsWith('FINAL')) return 'Finalizado';
  if (s.startsWith('AGUARD')) return 'Aguardando retorno';
  if (s.includes('NUNCA') && s.includes('RESPOND')) return 'Nunca respondeu';
  if (s.includes('ATENDIMENTO') && s.includes('INICIA')) return 'Atendimento iniciado';
  /* fallback: Title Case p/ não fragmentar status por caixa ("NUNCA" vs "Nunca") */
  const t = String(raw).trim();
  return t ? t.toLowerCase().replace(/(^|\s)([a-zà-ÿ])/g, (m,p,c) => p + c.toUpperCase()) : 'Sem status';
}

function normCRMOrigem(raw) {
  if (!raw || raw === '-' || raw === 'null') return 'Não informado';
  const s = String(raw).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'');
  if (s.includes('instagram') || s.includes('intagram') || s.includes('instag')) return 'Instagram';
  if (s.includes('youtube'))   return 'YouTube';
  if (s.includes('google'))    return 'Google';
  if (s.includes('whatsapp') || s.startsWith('whats'))  return 'WhatsApp';
  if (s.includes('trafego') || s.includes('anuncio') || s.includes('ads')) return 'Tráfego';
  if (s === 'site' || s.includes('site '))  return 'Site';
  if (s.includes('indicac') || s.includes('indicou') || s.includes('dr.') || s.includes('dra.')) return 'Indicação';
  if (!s || s === 'nao informado' || s === 'nao_informado') return 'Não informado';
  /* fallback: Title Case p/ não fragmentar por caixa ("TRÁFEGO" vs "Tráfego") */
  return String(raw).trim().toLowerCase().replace(/(^|\s)([a-zà-ÿ])/g, (m,p,c) => p + c.toUpperCase());
}

/* Normaliza o campo "Plano de saúde?" → nome do convênio, ou null se não tem */
function normCRMConvenio(raw) {
  if (!raw) return null;
  // remove prefixo "Sim", "Sim -", "Sim," → sobra a operadora (se houver)
  let txt = String(raw).trim().replace(/^sim\b[\s,;:.\-]*/i, '').trim();
  const s = txt.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();

  // valores que NÃO são operadora (sem convênio, notas ou status vazado de outras colunas)
  const naoConv = new Set(['','-','--','nao','n','nenhum','sem','particular','null','na','n/d',
    'agendado','em andamento','em atendimento','finalizado','follow','declinado','reagendar',
    'nao citado','nao informado','nao reembolsa','reembolsa','sim','x']);
  if (naoConv.has(s) || s.startsWith('nao ') || s.startsWith('particular') ||
      s.startsWith('esta mudando') || s.startsWith('servidora') || s.startsWith('de servidora'))
    return null;

  // agrupa operadoras conhecidas (cobre variantes de grafia)
  if (s.includes('unimed'))                                  return 'Unimed';
  if (s.includes('sul america') || s.includes('sulamerica')) return 'SulAmérica';
  if (s.includes('porto'))                                   return 'Porto Seguro';
  if (s.includes('bradesco'))                                return 'Bradesco';
  if (s.includes('notre'))                                   return 'NotreDame';
  if (s.includes('amil'))                                    return 'Amil';
  if (s.includes('prevent'))                                 return 'Prevent Senior';
  if (s.includes('med senior') || s.includes('medsenior'))   return 'Med Senior';
  if (s.includes('hap'))                                     return 'Hapvida';
  if (s.includes('care plus') || s.includes('careplus') || s.includes('care +')) return 'Care Plus';
  if (s.includes('intermedica'))                             return 'Intermédica';
  if (s.includes('biovida'))                                 return 'Biovida Saúde';
  if (s.includes('golden'))                                  return 'Golden Cross';
  if (s.includes('omint'))                                   return 'Omint';
  if (s.includes('sompo'))                                   return 'Sompo';
  if (s.includes('geap'))                                    return 'GEAP';
  if (s.includes('iamspe'))                                  return 'IAMSPE';
  if (s.includes('sao francisco'))                           return 'São Francisco';
  if (s.includes('sao cristovao'))                           return 'São Cristóvão';
  if (s.includes('sao bernardo'))                            return 'São Bernardo';
  if (s.includes('santa casa'))                              return 'Santa Casa';
  if (s.includes('trasmontano'))                             return 'Trasmontano';
  if (s.includes('correios') || s.includes('portal saude'))  return 'Portal Saúde';
  if (s.includes('alice'))                                   return 'Alice';
  if (s.includes('medservice'))                              return 'Medservice';
  if (s.includes('sistema saude'))                           return 'Sistema Saúde';
  if (s.includes('geap'))                                    return 'GEAP';
  if (s.includes('unica'))                                   return 'Única';
  if (s.includes('iamspe') || s.includes('cbpm') || s.includes('caixa')) return 'Outros (servidor público)';

  // fallback: Title Case seguro (não quebra em letras acentuadas)
  return txt.toLowerCase().replace(/(^|\s)([a-zà-ÿ])/g, (m,p,c) => p + c.toUpperCase());
}

/* Parser robusto de grid de CRM — usado APENAS em Maio/Junho.
   Lida com abas de estruturas variadas:
     - cabeçalho na linha 1 ou na linha 2 (após título mesclado)
     - múltiplas seções com cabeçalhos repetidos (ex: "Maio 2026")
     - com coluna STATUS (formato novo) ou sem (formato antigo, usa "Fechou?")
   Detecta cabeçalhos linha a linha e aplica o mapa de colunas vigente. */
function parseCRMGrid(grid) {
  if (!grid || !grid.length) return [];
  const result = [];
  let map = null;

  const cellStr   = c => String(c == null ? '' : c).trim();
  const normCell  = c => norm(cellStr(c));
  const isHeader  = (cells) => {
    const n = cells.map(normCell);
    return n.includes('nome') || (n.includes('status') && n.includes('origem'));
  };
  const buildMap = (cells) => {
    const n = cells.map(normCell);
    const find = (al) => n.findIndex(x => al.includes(x));
    const idxStatus = find(['status']);
    /* formato NOVO (STATUS na col 0): layout posicional fixo.
       Necessário porque alguns cabeçalhos têm Telefone/Data em branco e não
       dá pra localizá-los por nome:
       0=STATUS 1=Nome 2=Telefone 3=Origem 4=Cidade 5=Data 6=Motivo 7=Plano */
    if (idxStatus === 0) {
      return { idxNome:1, idxTel:2, idxStatus:0, idxFechou:-1, idxOrigem:3, idxData:5, idxConv:7, isNew:true };
    }
    /* formato ANTIGO: Nome|Telefone|Origem|Data|Fechou?|Motivo.
       Usa o cabeçalho quando o rótulo existe; senão cai na posição padrão
       (vários cabeçalhos têm Telefone/Data em branco). */
    const at = (al, def) => { const i = find(al); return i >= 0 ? i : def; };
    let idxData = find(['data_contato']); if (idxData < 0) idxData = find(['data']); if (idxData < 0) idxData = 3;
    return {
      idxNome:   at(['nome'], 0),
      idxTel:    at(['telefone','telefone_','fone','whatsapp'], 1),
      idxStatus: -1,
      idxFechou: at(['fechou','fechou_'], 4),
      idxOrigem: at(['origem'], 2),
      idxData,
      idxConv:   find(['plano_de_saude','plano_de_saude_','convenio']),
      isNew:     false,
    };
  };
  // mapa padrão (formato novo) — usado quando uma seção começa antes do cabeçalho
  const DEFAULT_MAP = { idxNome:1, idxTel:2, idxStatus:0, idxFechou:-1, idxOrigem:3, idxData:5, idxConv:7, isNew:true };

  let emFollow = false;  // dentro da seção "Follow - próximo mês"
  for (const cells of grid) {
    if (!cells.some(c => cellStr(c))) continue;           // linha vazia
    /* seção "Follow - PRÓXIMO MÊS": os leads seguintes são o pipeline em
       acompanhamento. Continuam CONTANDO como leads (total), mas são marcados
       como "Follow" — não são conversão. Só o que muda é a etiqueta. */
    if (norm(cells.map(c => cellStr(c)).join(' ')).includes('proximo_mes')) { emFollow = true; continue; }
    if (isHeader(cells)) { map = buildMap(cells); continue; } // cabeçalho → atualiza mapa
    const filled = cells.filter(c => cellStr(c)).length;
    if (filled <= 1) continue;                            // título de seção (1 célula)

    const m = map || DEFAULT_MAP;
    const g = (i) => (i >= 0 && i < cells.length) ? cells[i] : '';
    const nome   = cellStr(g(m.idxNome));
    const origem = cellStr(g(m.idxOrigem));
    const nn = norm(nome);
    if (nn === 'nome' || nn === 'status') continue;       // cabeçalho repetido
    if (/^(lead de |follow\s*-|proximo mes)/i.test(nome)) continue; // título caiu no nome
    if (!nome && !origem) continue;

    const rawStatus = m.isNew
      ? cellStr(g(m.idxStatus))
      : (m.idxFechou >= 0 ? cellStr(g(m.idxFechou)) : '');
    let status = normCRMStatus(rawStatus, m.isNew);
    /* na seção de follow, leads sem status são acompanhamento em andamento */
    if (emFollow && status === 'Sem status') status = 'Follow';

    result.push({
      nome,
      telefone: cellStr(g(m.idxTel)),
      origem:   normCRMOrigem(origem),
      status,
      convenio: normCRMConvenio(g(m.idxConv)),
      date:     parseCRMDate(g(m.idxData)),
    });
  }
  return result;
}
