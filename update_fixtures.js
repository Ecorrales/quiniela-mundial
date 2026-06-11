/**
 * update_fixtures.js
 * -----------------------------------------------------------------------------
 * Consulta API-Football, filtra los equipos de los grupos objetivo (C, E, K),
 * deduce si cada equipo sigue "activo" o ya fue "eliminado" y escribe/actualiza
 * los documentos en la colección "equipos_quiniela" de Cloud Firestore.
 *
 * Pensado para correr de forma desatendida en GitHub Actions.
 *
 * Variables de entorno requeridas:
 *   - API_FOOTBALL_KEY          API key de api-sports.io
 *   - FIREBASE_SERVICE_ACCOUNT  JSON completo de la cuenta de servicio (pegado tal cual)
 * Variables opcionales (tienen valores por defecto):
 *   - LEAGUE_ID (1)  - SEASON (2026)  - GRUPOS ("C,E,K")  - COLECCION ("equipos_quiniela")
 * -----------------------------------------------------------------------------
 */

const axios = require("axios");
const admin = require("firebase-admin");

// ---------- Configuración ----------
const API_BASE = "https://v3.football.api-sports.io";
const LEAGUE_ID = Number(process.env.LEAGUE_ID || 1); // 1 = FIFA World Cup en API-Football
const SEASON = Number(process.env.SEASON || 2026);
const GRUPOS_OBJETIVO = (process.env.GRUPOS || "C,E,K")
  .split(",")
  .map((g) => g.trim().toUpperCase());
const COLECCION = process.env.COLECCION || "equipos_quiniela";

// Rondas de eliminación directa en el formato de 48 equipos (Mundial 2026)
const RONDAS_KNOCKOUT = [
  "Round of 32",
  "Round of 16",
  "Quarter-finals",
  "Semi-finals",
  "3rd Place Final",
  "Final",
];

// Estados de partido que consideramos "terminados"
const ESTADOS_FINALIZADOS = ["FT", "AET", "PEN"];

// ---------- Utilidades ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Falta la variable de entorno: ${name}`);
    process.exit(1);
  }
  return v;
}

// "Group C" -> "C"
function letraGrupo(groupStr) {
  if (!groupStr) return null;
  const m = groupStr.match(/Group\s+([A-Z])/i);
  return m ? m[1].toUpperCase() : null;
}

function esRondaKnockout(round) {
  if (!round) return false;
  return RONDAS_KNOCKOUT.some((r) =>
    round.toLowerCase().includes(r.toLowerCase())
  );
}

// ID de documento seguro para Firestore (sin acentos, espacios ni símbolos)
function docId(nombre) {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------- Cliente API-Football ----------
const api = axios.create({
  baseURL: API_BASE,
  headers: { "x-apisports-key": requireEnv("API_FOOTBALL_KEY") },
  timeout: 20000,
});

async function getStandings() {
  const { data } = await api.get("/standings", {
    params: { league: LEAGUE_ID, season: SEASON },
  });
  if (!data.response?.length) return [];
  // response[0].league.standings = arreglo de grupos; cada grupo es un arreglo de equipos
  const grupos = data.response[0].league.standings || [];
  return grupos.flat();
}

async function getFixtures() {
  const { data } = await api.get("/fixtures", {
    params: { league: LEAGUE_ID, season: SEASON },
  });
  return data.response || [];
}

// ---------- Lógica principal ----------
async function main() {
  console.log(`▶️  Sincronizando Mundial (liga ${LEAGUE_ID}, temporada ${SEASON})`);
  console.log(`   Grupos objetivo: ${GRUPOS_OBJETIVO.join(", ")}`);

  // Firebase Admin
  const serviceAccount = JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT"));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const [standings, fixtures] = await Promise.all([getStandings(), getFixtures()]);

  // 1. Filtrar equipos de los grupos objetivo
  const equipos = standings.filter((s) =>
    GRUPOS_OBJETIVO.includes(letraGrupo(s.group))
  );
  if (!equipos.length) {
    console.warn(
      "⚠️  No se encontraron equipos para los grupos objetivo. " +
        "¿Ya hay standings publicados para esta temporada?"
    );
  }

  // 2. Pre-procesar fixtures para deducir eliminaciones de fase directa
  const partidosFinalizados = fixtures.filter((f) =>
    ESTADOS_FINALIZADOS.includes(f.fixture.status.short)
  );
  const knockoutFixtures = fixtures.filter((f) => esRondaKnockout(f.league.round));

  // Equipos que ya perdieron un partido de eliminación directa
  const perdedoresKnockout = new Set();
  for (const f of partidosFinalizados) {
    if (!esRondaKnockout(f.league.round)) continue;
    const { home, away } = f.teams;
    if (home.winner === false) perdedoresKnockout.add(home.id);
    if (away.winner === false) perdedoresKnockout.add(away.id);
  }

  // Equipos que YA aparecen en el cuadro de eliminación (con ID real, no placeholder)
  const enKnockout = new Set();
  for (const f of knockoutFixtures) {
    if (f.teams.home.id) enKnockout.add(f.teams.home.id);
    if (f.teams.away.id) enKnockout.add(f.teams.away.id);
  }
  const cuadroDibujado = enKnockout.size > 0; // ya hay equipos reales asignados al bracket

  // 3. Determinar estatus y armar el batch
  const batch = db.batch();
  const resumen = [];

  for (const s of equipos) {
    const grupo = letraGrupo(s.group);
    const jugados = s.all?.played ?? 0;
    const faseGruposCompleta = jugados >= 3;
    const rank = s.rank;

    let status = "activo";
    let nota = "fase de grupos en curso";

    if (perdedoresKnockout.has(s.team.id)) {
      status = "eliminado";
      nota = "perdió en fase de eliminación directa";
    } else if (faseGruposCompleta) {
      if (rank === 4) {
        status = "eliminado";
        nota = "último de grupo";
      } else if (rank === 3) {
        // Regla de los 8 mejores terceros: el 3.º es AMBIGUO hasta que se dibuja el cuadro.
        // En cuanto el bracket tiene equipos reales, basamos la decisión en si el equipo
        // aparece o no en él (evita reimplementar el desempate entre terceros de FIFA).
        if (cuadroDibujado) {
          status = enKnockout.has(s.team.id) ? "activo" : "eliminado";
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
      id: s.team.name,
      grupo,
      status,
      puntos: s.points ?? 0,
      goles_favor: s.all?.goals?.for ?? 0,
      // Campos extra útiles para la quiniela (opcionales)
      goles_contra: s.all?.goals?.against ?? 0,
      diferencia: s.goalsDiff ?? 0,
      posicion: rank ?? null,
      jugados,
      logo: s.team.logo ?? null,
      ultimo_update: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(db.collection(COLECCION).doc(docId(s.team.name)), docData, {
      merge: true,
    });
    resumen.push(
      `   [${grupo}] ${String(s.team.name).padEnd(22)} → ${status} (${nota})`
    );
  }

  await batch.commit();

  console.log(`✅ Actualizados ${equipos.length} equipos en "${COLECCION}":`);
  if (resumen.length) console.log(resumen.join("\n"));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Error en la sincronización:", err.response?.data || err.message);
    process.exit(1);
  });
