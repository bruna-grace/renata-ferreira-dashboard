/**
 * Leitura da planilha do CRM pelo endpoint gviz do Google.
 *
 * Com o segredo GOOGLE_SA_JSON (chave JSON de uma conta de serviço com acesso
 * de LEITOR à planilha), a leitura é autenticada — e a planilha pode ficar
 * PRIVADA. Sem o segredo, lê como hoje (planilha pública pelo link).
 *   wrangler secret put GOOGLE_SA_JSON < chave-da-conta-de-servico.json
 */

const ESCOPOS = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly';

/** Consulta gviz e devolve a `table` da resposta. `publica: true` lê sem a
    conta de serviço (planilhas abertas pelo link, como a de métricas). */
export async function consultarPlanilha(env, { planilha, gid, aba, range, tq, headers = 1, publica = false }) {
  const params = { tqx: 'out:json', headers };
  if (gid)   params.gid = gid;
  if (aba)   params.sheet = aba;
  if (range) params.range = range;
  if (tq)    params.tq = tq;
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  const token = publica ? null : await tokenGoogle(env);
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${planilha}/gviz/tq?${qs}`,
                          token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!res.ok) throw new Error(`Sheets respondeu ${res.status}`);
  const txt = await res.text();
  /* planilha privada sem credencial válida → o Google devolve a página de login (HTTP 200) */
  if (!txt.includes('setResponse(')) throw new Error('Sheets não devolveu dados — planilha privada sem acesso da conta de serviço?');
  const dados = JSON.parse(txt.slice(txt.indexOf('(') + 1, txt.lastIndexOf(')')));
  if (dados.status !== 'ok') throw new Error('gviz: ' + JSON.stringify(dados.errors || dados.status));
  return dados.table;
}

/* Token OAuth da conta de serviço (JWT assinado com RS256), reaproveitado
   enquanto vale — dentro de uma execução do cron são várias consultas. */
let cache = null;

async function tokenGoogle(env) {
  if (!env.GOOGLE_SA_JSON) return null;
  if (cache && cache.expira > Date.now() + 60_000) return cache.token;

  const sa = JSON.parse(env.GOOGLE_SA_JSON);
  const agora = Math.floor(Date.now() / 1000);
  const parte = obj => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const corpo = parte({ alg: 'RS256', typ: 'JWT' }) + '.' + parte({
    iss: sa.client_email, scope: ESCOPOS,
    aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600,
  });
  const chave = await crypto.subtle.importKey('pkcs8', pemParaDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(corpo));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}` +
          `&assertion=${corpo}.${base64url(new Uint8Array(assinatura))}`,
  });
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { access_token, expires_in } = await res.json();
  cache = { token: access_token, expira: Date.now() + expires_in * 1000 };
  return access_token;
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemParaDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}
