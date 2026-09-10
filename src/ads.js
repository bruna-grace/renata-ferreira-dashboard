/**
 * Investimento em Google Ads por mês, lido da planilha de métricas (preenchida
 * pelo script do Google Ads — renata-ferreira/ads-renata/ads-script-export.js).
 *
 *  1. Aba Ads_Historico (script atualizado): histórico completo mês × campanha.
 *  2. Senão, aba Ads_Mes: só "mês anterior" e "mês atual". Nesse caso o
 *     histórico vai sendo ACUMULADO no KV, dia após dia — os meses que já saíram
 *     da janela continuam salvos.
 *
 * O mês corrente é sempre parcial (o script roda ~5h e inclui o dia).
 */
import { consultarPlanilha } from './google.js';
import { mesDe } from './planilha-crm.js';

const PLANILHA_METRICAS = '1RuTUcnxjWmAkXYtCQSLRX3pLdLo6H1qsTskGdQTrTeU';

export async function lerInvestimento(env, anterior) {
  const historico = await lerHistorico(env);
  if (historico) return { fonte: 'Ads_Historico', meses: historico };

  const janela = await lerAdsMes(env);
  return { fonte: 'Ads_Mes', meses: { ...(anterior?.meses || {}), ...janela } };
}

/* Ads_Historico: Mês | Campanha | Tipo | Custo (R$) | Cliques | Impressões | Conversões */
async function lerHistorico(env) {
  let t;
  try { t = await consultarPlanilha(env, { planilha: PLANILHA_METRICAS, aba: 'Ads_Historico', publica: true }); }
  catch { return null; }
  /* aba inexistente → o gviz devolve a PRIMEIRA aba, sem erro: confere o cabeçalho */
  const cab = t.cols.map(c => String(c.label || '').toLowerCase());
  const col = nome => cab.findIndex(h => h.startsWith(nome));
  const [iMes, iCamp, iTipo, iCusto, iCliq, iConv] = ['mês', 'campanha', 'tipo', 'custo', 'cliques', 'conversões'].map(col);
  if (iMes < 0 || iCamp < 0 || iCusto < 0) return null;

  const meses = {};
  for (const r of t.rows || []) {
    const v = i => (i >= 0 ? r.c?.[i]?.v : null);
    const mes = mesDe(v(iMes) ?? r.c?.[iMes]?.f);
    if (!mes) continue;
    somar(meses, mes, {
      nome: String(v(iCamp) || ''), tipo: String(v(iTipo) || tipoPeloNome(v(iCamp))),
      custo: num(v(iCusto)), cliques: num(v(iCliq)), conversoes: num(v(iConv)),
    });
  }
  return meses;
}

/* Ads_Mes: blocos "MÊS ANTERIOR (fechado)" e "MÊS ATUAL (...)", uma linha por
   campanha (Campanha | Custo | Cliques | Impressões | CTR | CPC | Conversões …)
   até a linha TOTAL. Qual mês é qual sai da data em Ads_Meta. */
async function lerAdsMes(env) {
  const [meta, grade] = await Promise.all([
    consultarPlanilha(env, { planilha: PLANILHA_METRICAS, aba: 'Ads_Meta', headers: 0, publica: true }),
    consultarPlanilha(env, { planilha: PLANILHA_METRICAS, aba: 'Ads_Mes', headers: 0, publica: true }),
  ]);
  const linhaData = (meta.rows || []).find(r => /atualiza/i.test(String(r.c?.[0]?.v || '')));
  const quando = dataDe(linhaData?.c?.[1]);
  if (!quando) throw new Error('Ads_Meta sem data de atualização');
  const atual = `${quando.y}-${String(quando.m).padStart(2, '0')}`;
  const ant = quando.m === 1 ? `${quando.y - 1}-12` : `${quando.y}-${String(quando.m - 1).padStart(2, '0')}`;

  const meses = {};
  let mes = null;
  for (const r of grade.rows || []) {
    const a = String(r.c?.[0]?.v ?? '').trim();
    if (/^M[ÊE]S ANTERIOR/i.test(a)) { mes = ant; meses[mes] = vazio(); continue; }
    if (/^M[ÊE]S ATUAL/i.test(a))    { mes = atual; meses[mes] = vazio(); continue; }
    if (!mes || !a || a === 'Campanha' || a === 'TOTAL') { if (a === 'TOTAL') mes = null; continue; }
    somar(meses, mes, {
      nome: a, tipo: tipoPeloNome(a),
      custo: num(r.c?.[1]?.v), cliques: num(r.c?.[2]?.v), conversoes: num(r.c?.[6]?.v),
    });
  }
  return meses;
}

const vazio = () => ({ custo: 0, cliques: 0, conversoes: 0, campanhas: [] });

function somar(meses, mes, c) {
  const m = (meses[mes] ||= vazio());
  if (!c.custo && !c.cliques) return;          // campanha parada no mês
  m.custo = arred(m.custo + c.custo);
  m.cliques += c.cliques;
  m.conversoes = arred(m.conversoes + c.conversoes);
  m.campanhas.push({ ...c, custo: arred(c.custo), conversoes: arred(c.conversoes) });
}

/* Ads_Mes não traz o tipo da campanha; o nome resolve nas campanhas da Renata */
function tipoPeloNome(nome) {
  const n = String(nome || '').toLowerCase();
  if (n.includes('youtube') || n.includes('vídeo') || n.includes('video')) return 'VIDEO';
  if (/\bmax\b/.test(n)) return 'PERFORMANCE_MAX';
  if (n.includes('display')) return 'DISPLAY';
  return 'SEARCH';
}

/* "10/09/2026 5:27" ou Date(2026,8,10,5,27,0) → { y, m } */
function dataDe(cell) {
  const v = String(cell?.v ?? ''), f = String(cell?.f ?? '');
  let m = /^Date\((\d+),(\d+)/.exec(v);
  if (m) return { y: +m[1], m: +m[2] + 1 };
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v) || /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(f);
  return m ? { y: +m[3], m: +m[2] } : null;
}

const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const arred = n => Math.round(n * 100) / 100;
