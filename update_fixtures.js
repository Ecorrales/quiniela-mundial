/**
 * update_fixtures.js  (versión football-data.org / API v4)
 * -----------------------------------------------------------------------------
 * Consulta football-data.org, filtra los equipos de los grupos objetivo
 * (C, E, K), deduce si cada equipo sigue "activo" o ya fue "eliminado" y
 * escribe/actualiza los documentos en la colección "equipos_quiniela".
 *
 * Pensado para correr desatendido en GitHub Actions.
 *
 * Variables de entorno requeridas:
 *   - FOOTBALL_DATA_TOKEN       Token de football-data.org (header X-Auth-Token)
 *   - FIREBASE_SERVICE_ACCOUNT  JSON completo de la cuenta de servicio
 * Variables opcionales (con valores por defecto):
 *   - COMPETITION ("WC")  - GRUPOS ("C,E,K")  - COLECCION ("equipos_quiniela")
 * -----------------------------------------------------------------------------
 */

const axios = require("axios");
const admin = require("firebase-admin");

// ---------- Configuración ----------
const API_BASE = "https://api.football-data.org/v4";
const COMPETITION = process.env.COMPETITION || "WC"; // WC = FIFA World Cup
const GRUPOS_OBJETIVO = (process.env.GRUPOS || "C,E,K")
  .split(",")
  .map((g) => g.trim().toUpperCase());
const COLECCION = process.env.COLECCION || "equipos_quiniela";
// Año de INICIO de la temporada (football-data lo pide así: 2026 para el Mundial 2026).
// Si lo dejas vacío, la API usa la temporada vigente de la competencia.
const SEASON = process.env.SEASON ? Number(process.env.SEASON) : null;

// En football-data, cualquier etapa que NO sea fase de grupos es eliminación directa.
const ETAPA_GRUPOS = "GROUP_STAGE";

// ---------- Utilidades ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Falta la variable de entorno: ${name}`);
    process.exit(1);
  }
  return v;
}

// "GROUP_C" -> "C"
function letraGrupo(groupStr) {
  if (!groupStr) return null;
  const m = String(groupStr).match(/GROUP[_\s]?([A-Z])/i);
  return m ? m[1].toUpperCase() : null;
}

function esKnockout(stage) {
  return stage && stage !== ETAPA_GRUPOS;
}

// ID de documento seguro para Firestore
function docId(nombre) {
  return String(nombre)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------- Cliente football-data ----------
const api = axios.create({
  baseURL: API_BASE,
  headers: { "X-Auth-Token": requireEnv("FOOTBALL_DATA_TOKEN") },
  timeout: 20000,
});

async function getStandings() {
  const params = SEASON ? { season: SEASON } : {};
  const { data } = await api.get(`/competitions/${COMPETITION}/standings`, { params });
  // data.standings = arreglo de bloques; cada bloque tiene type (TOTAL/HOME/AWAY),
  // group ("GROUP_C") y table (arreglo de equipos). Nos quedamos con TOTAL.
  return (data.standings || []).filter((s) => s.type === "TOTAL");
}

async function getMatches() {
  const params = SEASON ? { season: SEASON } : {};
  const { data } = await api.get(`/competitions/${COMPETITION}/matches`, { params });
  return data.matches || [];
}

// ---------- Lógica principal ----------
async function main() {
  console.log(`▶️  Sincronizando ${COMPETITION} (football-data.org)`);
  console.log(`   Temporada: ${SEASON || "vigente (default)"} · Grupos objetivo: ${GRUPOS_OBJETIVO.join(", ")}`);

  // Firebase Admin
  const serviceAccount = JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT"));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const [bloques, matches] = await Promise.all([getStandings(), getMatches()]);

  // 1. Quedarnos solo con los grupos objetivo y aplanar a una lista de filas
  const filas = [];
  for (const bloque of bloques) {
    const grupo = letraGrupo(bloque.group);
    if (!GRUPOS_OBJETIVO.includes(grupo)) continue;
    for (const fila of bloque.table || []) {
      filas.push({ grupo, ...fila });
    }
  }
  if (!filas.length) {
    console.warn(
      "⚠️  No se encontraron equipos para los grupos objetivo. " +
        "¿Ya hay tabla de posiciones publicada para esta competencia?"
    );
  }

  // 2. Pre-procesar partidos para deducir eliminaciones de fase directa
  const knockout = matches.filter((m) => esKnockout(m.stage));

  // Equipos que perdieron en eliminación directa
  const perdedoresKnockout = new Set();
  for (const m of knockout) {
    if (m.status !== "FINISHED") continue;
    const w = m.score?.winner; // HOME_TEAM | AWAY_TEAM | DRAW | null
    if (w === "HOME_TEAM" && m.awayTeam?.id) perdedoresKnockout.add(m.awayTeam.id);
    if (w === "AWAY_TEAM" && m.homeTeam?.id) perdedoresKnockout.add(m.homeTeam.id);
  }

  // Equipos ya presentes en el cuadro (con id real, no placeholder)
  const enKnockout = new Set();
  for (const m of knockout) {
    if (m.homeTeam?.id) enKnockout.add(m.homeTeam.id);
    if (m.awayTeam?.id) enKnockout.add(m.awayTeam.id);
  }
  const cuadroDibujado = enKnockout.size > 0;

  // 3. Determinar estatus y armar el batch
  const batch = db.batch();
  const resumen = [];

  for (const f of filas) {
    const jugados = f.playedGames ?? 0;
    const faseGruposCompleta = jugados >= 3;
    const rank = f.position;
    const teamId = f.team?.id;

    let status = "activo";
    let nota = "fase de grupos en curso";

    if (teamId && perdedoresKnockout.has(teamId)) {
      status = "eliminado";
      nota = "perdió en fase de eliminación directa";
    } else if (faseGruposCompleta) {
      if (rank === 4) {
        status = "eliminado";
        nota = "último de grupo";
      } else if (rank === 3) {
        // Regla de los 8 mejores terceros: el 3.º es ambiguo hasta que se dibuja
        // el cuadro. En cuanto hay bracket con equipos reales, decidimos por
        // presencia en él (evita reimplementar el desempate de FIFA).
        if (cuadroDibujado) {
          status = teamId && enKnockout.has(teamId) ? "activo" : "eliminado";
          nota =
            status === "eliminado"
              ? "tercero NO clasificado (mejores terceros)"
              : "tercero clasificado (mejores terceros)";
        } else {
          status = "activo";
          nota = "tercero — desempate de mejores terceros aún por definir";
        }
      } else {
        nota = "clasificó como 1.º o 2.º de grupo";
      }
    }

    const docData = {
      id: f.team?.name ?? "—",
      grupo: f.grupo,
      status,
      puntos: f.points ?? 0,
      goles_favor: f.goalsFor ?? 0,
      goles_contra: f.goalsAgainst ?? 0,
      diferencia: f.goalDifference ?? 0,
      posicion: rank ?? null,
      jugados,
      logo: f.team?.crest ?? null,
      ultimo_update: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(db.collection(COLECCION).doc(docId(docData.id)), docData, {
      merge: true,
    });
    resumen.push(
      `   [${f.grupo}] ${String(docData.id).padEnd(22)} → ${status} (${nota})`
    );
  }

  await batch.commit();

  console.log(`✅ Actualizados ${filas.length} equipos en "${COLECCION}":`);
  if (resumen.length) console.log(resumen.join("\n"));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error en la sincronización:", err.response?.data || err.message);
    process.exit(1);
  });
