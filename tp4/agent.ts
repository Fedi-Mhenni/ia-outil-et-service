// TP 4.2 — Tool calling avec la Responses API : le modèle ne fait rien, il DEMANDE. Votre code exécute.
//
// La boucle d'agent :
//   1. on envoie la demande + la liste des outils
//   2. la réponse contient soit du texte (fin), soit des éléments « function_call »
//   3. on exécute chaque appel, on renvoie un élément « function_call_output » (même call_id), on recommence
//
// Différence clé avec Chat Completions : l'état peut rester CÔTÉ SERVEUR. Avec previous_response_id,
// on n'envoie que les nouveaux éléments ; OpenAI retrouve le reste (il faut alors store: true).
import { z } from "zod";
import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import { config, openai } from "../src/config.js";

// --- Le « système d'information » fictif --------------------------------
const salles = [
  { id: "S-ATLAS", nom: "Atlas", places: 4, equipement: ["écran"] },
  { id: "S-BOREAL", nom: "Boréal", places: 10, equipement: ["écran", "visio"] },
  { id: "S-CAP", nom: "Cap", places: 16, equipement: ["écran", "visio", "tableau blanc"] },
];
const reservations: { salle_id: string; date: string; debut: string; fin: string; objet: string }[] = [
  { salle_id: "S-BOREAL", date: demain(), debut: "14:00", fin: "15:00", objet: "Point client" },
];

// --- Les outils : un schéma zod pour valider, une fonction pour exécuter -----
const ChercherArgs = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), participants: z.number().int().min(1) });
const ReserverArgs = z.object({
  salle_id: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  debut: z.string().regex(/^\d{2}:\d{2}$/), fin: z.string().regex(/^\d{2}:\d{2}$/), objet: z.string().max(80),
});

const implementations: Record<string, (args: unknown) => unknown> = {
  chercher_salles: (raw) => {
    const { date, participants } = ChercherArgs.parse(raw);
    return salles
      .filter((s) => s.places >= participants)
      .map((s) => ({ ...s, occupee: reservations.filter((r) => r.salle_id === s.id && r.date === date).map((r) => `${r.debut}-${r.fin}`) }));
  },
  reserver_salle: (raw) => {
    const a = ReserverArgs.parse(raw);
    if (!salles.some((s) => s.id === a.salle_id)) return { ok: false, erreur: "salle inconnue" };
    const conflit = reservations.find((r) => r.salle_id === a.salle_id && r.date === a.date && r.debut < a.fin && a.debut < r.fin);
    if (conflit) return { ok: false, erreur: `créneau déjà pris (${conflit.debut}-${conflit.fin})` };
    reservations.push(a);
    return { ok: true, reference: `R-${reservations.length.toString().padStart(4, "0")}` };
  },
};

const tools: FunctionTool[] = [
  {
    type: "function",
    name: "chercher_salles",
    description: "Liste les salles de réunion ayant assez de places, avec leurs créneaux déjà occupés à la date donnée.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date au format AAAA-MM-JJ" },
        participants: { type: "integer", description: "Nombre de personnes" },
      },
      required: ["date", "participants"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "reserver_salle",
    description: "Réserve une salle sur un créneau. Ne l'appeler qu'après avoir vérifié la disponibilité.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        salle_id: { type: "string" },
        date: { type: "string", description: "AAAA-MM-JJ" },
        debut: { type: "string", description: "HH:MM" },
        fin: { type: "string", description: "HH:MM" },
        objet: { type: "string", description: "Objet court de la réunion" },
      },
      required: ["salle_id", "date", "debut", "fin", "objet"],
      additionalProperties: false,
    },
  },
];

// --- La boucle -----------------------------------------------------------
const client = openai();
const MAX_STEPS = 6; // garde-fou : un agent sans borne peut boucler (et coûter) indéfiniment
const demande = process.argv.slice(2).join(" ") ||
  "Trouve une salle avec visio pour 8 personnes demain après-midi, 1 h, et réserve-la pour la rétro du sprint.";
// Les instructions ne sont PAS reprises par previous_response_id : on les renvoie à chaque appel.
const instructions = `Tu es l'assistant de réservation de salles d'Orion. Nous sommes le ${aujourdhui()}. Utilise les outils ; ne prétends jamais avoir réservé sans appel réussi à reserver_salle.`;

let input: ResponseInputItem[] = [{ role: "user", content: demande }];
let previous: string | undefined;
for (let step = 1; step <= MAX_STEPS; step++) {
  const res = await client.responses.create({ model: config.model, instructions, input, tools, previous_response_id: previous, temperature: 0 });
  previous = res.id; // l'historique reste chez OpenAI : au tour suivant, on n'envoie que les résultats
  const calls = res.output.filter((item) => item.type === "function_call");

  if (calls.length === 0) {
    console.log(`\n🤖 ${res.output_text}`);
    break;
  }
  input = [];
  for (const call of calls) {
    const impl = implementations[call.name]; // liste blanche : on n'exécute que ce qu'on connaît
    let result: unknown;
    try {
      if (!impl) throw new Error(`outil inconnu : ${call.name}`);
      result = impl(JSON.parse(call.arguments || "{}"));
    } catch (e) {
      // On renvoie l'erreur AU MODÈLE, lisible : il peut corriger ses arguments au tour suivant.
      const erreur = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; ") : (e as Error).message;
      result = { ok: false, erreur };
    }
    console.log(`  [tour ${step}] ${call.name}(${call.arguments}) → ${JSON.stringify(result)}`);
    input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
  }
  if (step === MAX_STEPS) console.log("⛔ MAX_STEPS atteint : on arrête l'agent.");
}

console.log("\nRéservations :", reservations);

function aujourdhui() { return new Date().toISOString().slice(0, 10); }
function demain() { return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); }
