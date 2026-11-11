// Brandloop · agente de investigación automática (lunes, miércoles y viernes, 5 a.m. Guatemala)
// Actualiza, marca por marca: tendencias del mercado y de redes, hashtags, competencia,
// eventos, asociaciones y auditoría web. Investiga con la API de Claude + búsqueda web.
// Cada llamada procesa UNA marca (la que tenga la investigación más vieja), para no pasar el tiempo límite.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const KEY = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
const API_VERSION = Deno.env.get("BL_API_VERSION") || "2026-10-21";
const AGENT_KEY = Deno.env.get("AGENT_KEY") || "";
const MODEL = Deno.env.get("BL_MODEL") || "claude-sonnet-5-5";
const SKIP = (Deno.env.get("BL_SKIP") || "paylink").split(",").map((s) => s.trim()).filter(Boolean);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const now = () => Date.now();
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

async function getDoc(path: string) {
  const { data } = await db.from("docs").select("data").eq("path", path).maybeSingle();
  return data ? data.data : null;
}
async function listCol(path: string) {
  const { data } = await db.from("docs").select("path,data").eq("parent", path);
  return (data || []).map((r: any) => ({ id: r.path.split("/").pop(), ...r.data }));
}
async function put(path: string, data: unknown) {
  const { error } = await db.from("docs").upsert({ path, parent: parentOf(path), data, updated_at: new Date().toISOString() });
  if (error) throw error;
}
async function merge(path: string, patch: Record<string, unknown>) {
  const cur = (await getDoc(path)) || {};
  await put(path, { ...cur, ...patch }); // conserva el campo cifrado "e" tal cual
}

async function claude(prompt: string) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 16000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 }],
    messages: [{ role: "user", content: prompt }],
  });
  const base = { "anthropic-version": API_VERSION, "content-type": "application/json" };
  let r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { ...base, "x-api-key": KEY }, body });
  if (r.status === 401) {
    // algunas claves nuevas se mandan como "Authorization: Bearer"
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { ...base, authorization: `Bearer ${KEY}` }, body });
  }
  const d = await r.json();
  if (!r.ok) throw new Error(`${d?.error?.message || "Anthropic"} (${r.status}; clave ${KEY.slice(0, 10)}…, ${KEY.length} caracteres)`);
  const text = (d.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}$/m) || text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("La respuesta no trajo JSON");
  try {
    return JSON.parse(m[0]);
  } catch {
    // a veces vienen saltos de línea dentro de los textos: se limpian y se intenta otra vez
    return JSON.parse(m[0].replace(/[\u0000-\u001F]+/g, " "));
  }
}

function brief(c: any) {
  return `Marca: ${c.name}\nSector: ${c.industry || "-"}\nPaís de su audiencia: ${c.country || "Guatemala"}\nSitio web: ${c.website || "-"}\nAudiencia: ${c.audience || "-"}\nNotas: ${String(c.notes || "").slice(0, 1200)}`;
}

async function research(cid: string) {
  const c = await getDoc(`clients/${cid}`);
  if (!c || !c.name) throw new Error("marca sin datos públicos");
  const comps = await listCol(`clients/${cid}/competitors`);
  const events = await listCol(`clients/${cid}/events`);
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Eres el agente de investigación de Brandloop, una plataforma de marketing en Guatemala. Hoy es ${today}.
${brief(c)}

Investiga en la web (varias búsquedas, prioriza lo publicado en los últimos 14 días y fuentes de su país y región). Abre su sitio web para entender qué vende.
Competidores que ya tenemos (no los repitas como nuevos): ${comps.map((x: any) => x.name).join("; ") || "ninguno"}.
Eventos que ya tenemos: ${events.map((x: any) => x.name).join("; ") || "ninguno"}.

Reglas: no inventes datos, cifras, eventos ni URLs; todo debe venir de una fuente que hayas visto. Parafrasea. Español.
Responde SOLO con un JSON con esta forma:
{"sector":[{"title","summary","why","idea","source","url"}x4],
 "social":[{"title","summary","why","idea","source","url","platform"}x4],
 "tags":{"es":[8-15 hashtags vistos en su nicho],"en":[8-15]},
 "newCompetitors":[{"name","type":"directa|indirecta","url","country","does":[2-4],"doesnt":[2-4],"channels":["Instagram","Facebook","LinkedIn","TikTok","YouTube","Web"],"channelsNote","opportunity"}] (0-4, solo importantes y reales),
 "events":[{"name","type","date":"YYYY-MM-DD","end","date_confirmed":true|false,"city","country","url","audience","why","play","cost"}] (próximos 12 meses, 0-6, solo nuevos o con datos actualizados),
 "summary":"1 frase con lo más importante para la marca esta semana"}`;
  const r = await claude(prompt);
  const t = now();
  const writes: Promise<unknown>[] = [];
  (r.sector || []).slice(0, 4).forEach((x: any, i: number) => writes.push(put(`clients/${cid}/trends/s${i + 1}`, { ...x, kind: "sector", order: i + 1, updatedAt: t })));
  (r.social || []).slice(0, 4).forEach((x: any, i: number) => writes.push(put(`clients/${cid}/trends/r${i + 1}`, { ...x, kind: "social", order: 10 + i, updatedAt: t })));
  if (r.tags) writes.push(merge(`clients/${cid}`, { trendTags: r.tags }));
  let k = comps.reduce((m: number, x: any) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  const have = new Set(comps.map((x: any) => String(x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const x of (r.newCompetitors || []).slice(0, 4)) {
    const key = String(x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || have.has(key)) continue;
    have.add(key);
    writes.push(put(`clients/${cid}/competitors/k${++k}`, { ...x, order: 100 + k, updatedAt: t, source: "investigacion" }));
  }
  let e = events.reduce((m: number, x: any) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  for (const x of (r.events || []).slice(0, 6)) {
    const old = events.find((y: any) => String(y.name || "").toLowerCase() === String(x.name || "").toLowerCase());
    if (old && old.source === "manual") continue;
    const path = old ? `clients/${cid}/events/${old.id}` : `clients/${cid}/events/e${++e}`;
    writes.push(put(path, { ...(old || {}), ...x, status: old?.status, estCost: old?.estCost, order: old?.order ?? e, updatedAt: t, source: "investigacion" }));
  }
  for (const x of events) if (x.date && x.date < today && !x.status && x.source !== "manual") writes.push(put(`clients/${cid}/events/${x.id}`, { ...x, status: "pasado" }));
  writes.push(put(`clients/${cid}/docs/research`, { at: t, summary: r.summary || "", model: MODEL }));
  await Promise.all(writes);
  return { cid, summary: r.summary || "" };
}

Deno.serve(async (req) => {
  if (!AGENT_KEY || req.headers.get("x-agent-key") !== AGENT_KEY) return json({ error: "no autorizado" }, 401);
  if (!KEY) return json({ error: "Falta ANTHROPIC_API_KEY" }, 500);
  const u = new URL(req.url);
  let cid = u.searchParams.get("cid");
  if (!cid) {
    // la marca con la investigación más vieja (y que no se haya hecho en las últimas 20 horas)
    const { data } = await db.from("docs").select("path").eq("parent", "clients");
    const ids = (data || []).map((r: any) => r.path.split("/")[1]).filter((id: string) => !SKIP.includes(id));
    const ages = await Promise.all(ids.map(async (id: string) => ({ id, at: ((await getDoc(`clients/${id}/docs/research`)) || {}).at || 0 })));
    const next = ages.filter((x) => now() - x.at > 20 * 3600e3).sort((a, b) => a.at - b.at)[0];
    if (!next) return json({ done: true });
    cid = next.id;
  }
  try {
    return json({ ok: true, ...(await research(cid)) });
  } catch (err) {
    await merge(`clients/${cid}/docs/research`, { error: String((err as Error).message || err), errorAt: now() }).catch(() => {});
    return json({ ok: false, cid, error: String((err as Error).message || err) }, 500);
  }
});
