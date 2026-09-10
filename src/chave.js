/* Chave anônima de um lead: a mesma pessoa tem que gerar a mesma chave nas
   abas manuais e no WaSeller. 8 últimos dígitos do telefone = imune a DDI,
   DDD e ao 9º dígito. Sem telefone, usa nome + data (não cruza entre fontes). */

export async function chaveTelefone(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  return d.length < 8 ? null : sha('rf:' + d.slice(-8));
}

export function chaveNome(nome, data) {
  return sha('nm:' + String(nome || '').toLowerCase().trim() + '|' + (data || ''));
}

async function sha(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
