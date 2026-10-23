// TP 5 — Relais vers la Realtime API d'OpenAI :
//   navigateur ⇄ (WebSocket n° 1, votre protocole) ⇄ votre serveur ⇄ (WebSocket n° 2, protocole OpenAI) ⇄ Realtime API
//
// Pourquoi un serveur au milieu ?
//   • la clé API ne doit JAMAIS arriver dans le navigateur ;
//   • c'est ici qu'on applique quotas, journalisation, filtrage, et qu'on traduit les protocoles ;
//   • les deux liaisons sont bidirectionnelles : on peut ANNULER une réponse pendant qu'elle s'écrit.
//
// Différence avec Chat Completions : la Realtime API est une SESSION. La conversation vit côté
// OpenAI tant que le WebSocket est ouvert ; on n'envoie que les nouveaux messages.
//
//   npm run tp5   puis ouvrir http://localhost:3000
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { config, requireKey } from "../src/config.js";

requireKey(); // échouer AU DÉMARRAGE plutôt qu'à la première requête

const PORT = Number(process.env.PORT ?? 3000);

// Protocole n° 1, entre le navigateur et nous : c'est VOUS qui le définissez.
const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("cancel") }),
]);
type ServerMsg =
  | { type: "start"; id: string }
  | { type: "delta"; id: string; text: string }
  | { type: "done"; id: string; ms: number; tokens?: number; cancelled?: boolean }
  | { type: "error"; message: string };

const http = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(new URL("./public/index.html", import.meta.url)));
  } else {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ server: http, path: "/ws" });

wss.on("connection", (browser: WebSocket & { alive?: boolean }) => {
  console.log("+ navigateur connecté");
  const toBrowser = (m: ServerMsg) => browser.readyState === WebSocket.OPEN && browser.send(JSON.stringify(m));
  let busy = false;
  let t0 = 0;
  browser.alive = true;
  browser.on("pong", () => (browser.alive = true));

  // Protocole n° 2 : une session Realtime par navigateur. La clé part dans l'en-tête, côté serveur.
  const openaiWs = new WebSocket(`${config.realtimeURL}?model=${encodeURIComponent(config.realtimeModel)}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  // Tant que la connexion n'est pas ouverte, on met les événements de côté (sinon ils sont perdus).
  const pending: object[] = [];
  const toOpenAI = (e: object) => {
    if (openaiWs.readyState === WebSocket.CONNECTING) pending.push(e);
    else if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(e));
  };
  openaiWs.on("open", () => {
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: { type: "realtime", output_modalities: ["text"], instructions: "Tu es un assistant concis. Réponds en français." },
    }));
    for (const e of pending.splice(0)) openaiWs.send(JSON.stringify(e));
  });
  openaiWs.on("error", (e) => toBrowser({ type: "error", message: `Realtime : ${e.message}` }));
  openaiWs.on("close", () => browser.close(1011, "session temps réel fermée"));

  // Événements serveur de la Realtime API → messages de NOTRE protocole.
  openaiWs.on("message", (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.type !== "response.output_text.delta") console.log("  OpenAI     →", e.type); // journal (les deltas sont trop nombreux)
    switch (e.type) {
      case "response.created":
        return toBrowser({ type: "start", id: e.response.id });
      case "response.output_text.delta":
        return toBrowser({ type: "delta", id: e.response_id, text: e.delta });
      case "response.done":
        busy = false;
        return toBrowser({ type: "done", id: e.response.id, ms: Date.now() - t0, tokens: e.response.usage?.total_tokens, cancelled: e.response.status === "cancelled" });
      case "error":
        busy = false;
        return toBrowser({ type: "error", message: e.error?.message ?? "erreur Realtime" });
      default:
        return; // session.created, session.updated, conversation.item.added… : rien à relayer
    }
  });

  browser.on("message", (raw) => {
    // 1. Ne jamais faire confiance au client : on valide chaque trame.
    let msg: z.infer<typeof ClientMsg>;
    try {
      msg = ClientMsg.parse(JSON.parse(raw.toString()));
    } catch {
      return toBrowser({ type: "error", message: "message invalide" });
    }
    console.log("  navigateur →", msg.type === "prompt" ? `prompt « ${msg.text} »` : msg.type);

    if (msg.type === "cancel") {
      if (busy) toOpenAI({ type: "response.cancel" });
      return;
    }

    if (busy) return toBrowser({ type: "error", message: "une réponse est déjà en cours" });

    busy = true;
    t0 = Date.now();
    toOpenAI({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: msg.text }] } });
    toOpenAI({ type: "response.create" });
  });

  browser.on("close", () => {
    openaiWs.close();
    console.log("- navigateur déconnecté, session Realtime fermée");
  });
});

// Battement de cœur : détecte les connexions mortes (Wi-Fi coupé, onglet tué) que TCP ne signale pas.
setInterval(() => {
  for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();

http.listen(PORT, () => {
  console.log(`TP 5 prêt. Ouvrez http://localhost:${PORT} dans votre navigateur et posez votre question dans la page.`);
  console.log(`(Ce terminal n'accepte pas de saisie : il affiche le journal des échanges. Modèle temps réel : ${config.realtimeModel},`);
  console.log(` serveur : ${config.isOpenAI ? "API OpenAI" : config.baseURL}. Ctrl+C pour arrêter.)`);
});
