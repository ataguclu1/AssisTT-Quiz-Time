import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { logger } from "./lib/logger";

interface PlayerData {
  name: string;
  avatar: { style: string; seed: string };
  score: number;
  answers: Record<number, { choice: number; ts: number }>;
  socketId: string;
}

interface GameSession {
  pin: string;
  hostSocketId: string;
  phase: "lobby" | "question" | "reveal" | "leaderboard" | "end";
  qIdx: number;
  questions: unknown[];
  players: Map<string, PlayerData>;
  qStartTs: number;
}

const sessions = new Map<string, GameSession>();

export function setupSocketIO(httpServer: HttpServer) {
  const io = new SocketIOServer(httpServer, {
    path: "/api/socket.io",
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    // ── HOST: Create session ──────────────────────────────────────────────
    socket.on("create-session", (data: { pin: string; questions: unknown[] }) => {
      const { pin, questions } = data;
      sessions.set(pin, {
        pin,
        hostSocketId: socket.id,
        phase: "lobby",
        qIdx: 0,
        questions,
        players: new Map(),
        qStartTs: 0,
      });
      socket.join(`game-${pin}`);
      socket.data.pin = pin;
      socket.data.isHost = true;
      socket.emit("session-created", { pin });
      logger.info({ pin }, "Game session created");
    });

    // ── PLAYER: Join session ──────────────────────────────────────────────
    socket.on("join-session", (data: { pin: string; name: string; avatar: { style: string; seed: string } }) => {
      const { pin, name, avatar } = data;
      const session = sessions.get(pin);

      if (!session) {
        socket.emit("join-error", { message: "Geçersiz PIN. Böyle bir oturum bulunamadı." });
        return;
      }
      if (session.phase !== "lobby") {
        socket.emit("join-error", { message: "Oturum çoktan başladı." });
        return;
      }
      if (session.players.has(name)) {
        socket.emit("join-error", { message: "Bu isim zaten kullanımda." });
        return;
      }

      const player: PlayerData = { name, avatar, score: 0, answers: {}, socketId: socket.id };
      session.players.set(name, player);
      socket.join(`game-${pin}`);
      socket.data.pin = pin;
      socket.data.name = name;

      socket.emit("join-success", { pin, name });

      // Notify host directly using socket id room (each socket auto-joins its id room)
      io.to(session.hostSocketId).emit("player-joined", {
        name, avatar, playerCount: session.players.size, players: getPlayersArray(session),
      });

      logger.info({ pin, name }, "Player joined session");
    });

    // ── PLAYER: Update avatar ─────────────────────────────────────────────
    socket.on("update-avatar", (data: { pin: string; name: string; avatar: { style: string; seed: string } }) => {
      const session = sessions.get(data.pin);
      if (!session) return;
      const player = session.players.get(data.name);
      if (!player) return;
      player.avatar = data.avatar;
      io.to(session.hostSocketId).emit("player-joined", {
        name: data.name, avatar: data.avatar,
        playerCount: session.players.size, players: getPlayersArray(session),
      });
    });

    // ── HOST: Start game ──────────────────────────────────────────────────
    socket.on("start-game", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "question";
      session.qIdx = 0;
      session.qStartTs = Date.now();

      const q = getQuestionForPlayers(session, 0);
      io.to(`game-${data.pin}`).emit("game-started", {
        qIdx: 0, question: q, total: session.questions.length,
      });
      logger.info({ pin: data.pin }, "Game started");
    });

    // ── HOST: Show question ───────────────────────────────────────────────
    socket.on("show-question", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "question";
      session.qIdx = data.qIdx;
      session.qStartTs = Date.now();

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: data.qIdx, question: getQuestionForPlayers(session, data.qIdx), total: session.questions.length,
      });
    });

    // ── PLAYER: Submit answer ─────────────────────────────────────────────
    socket.on("submit-answer", (data: { pin: string; name: string; qIdx: number; choice: number }) => {
      const { pin, name, qIdx, choice } = data;
      const session = sessions.get(pin);
      if (!session) return;

      const player = session.players.get(name);
      if (!player || player.answers[qIdx] !== undefined) return;

      player.answers[qIdx] = { choice, ts: Date.now() };

      const answeredCount = [...session.players.values()].filter(p => p.answers[qIdx] !== undefined).length;

      socket.emit("answer-recorded", { qIdx, choice });

      io.to(session.hostSocketId).emit("player-answered", {
        name, qIdx, choice, answeredCount,
        totalPlayers: session.players.size,
        answerCounts: getAnswerCounts(session, qIdx),
      });

      if (answeredCount >= session.players.size) {
        io.to(session.hostSocketId).emit("all-answered", { qIdx });
      }
    });

    // ── HOST: Reveal answer ───────────────────────────────────────────────
    socket.on("reveal-answer", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "reveal";
      const q = session.questions[data.qIdx] as Record<string, unknown>;

      calculateScores(session, data.qIdx);

      io.to(`game-${data.pin}`).emit("answer-revealed", {
        qIdx: data.qIdx,
        correctIndexes: getCorrectIndexes(q),
        playerScores: getPlayersScores(session),
      });
      logger.info({ pin: data.pin, qIdx: data.qIdx }, "Answer revealed");
    });

    // ── HOST: Show leaderboard ────────────────────────────────────────────
    socket.on("show-leaderboard", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "leaderboard";
      io.to(`game-${data.pin}`).emit("leaderboard-shown", {
        leaderboard: getSortedLeaderboard(session),
        isLast: session.qIdx >= session.questions.length - 1,
      });
    });

    // ── HOST: Next question ───────────────────────────────────────────────
    socket.on("next-question", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.qIdx++;
      session.phase = "question";
      session.qStartTs = Date.now();

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: session.qIdx, question: getQuestionForPlayers(session, session.qIdx), total: session.questions.length,
      });
    });

    // ── HOST: End game ────────────────────────────────────────────────────
    socket.on("end-game", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "end";
      io.to(`game-${data.pin}`).emit("game-ended", {
        leaderboard: getSortedLeaderboard(session),
      });

      sessions.delete(data.pin);
      logger.info({ pin: data.pin }, "Game ended");
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      const pin = socket.data.pin as string | undefined;
      const name = socket.data.name as string | undefined;
      const isHost = socket.data.isHost as boolean | undefined;

      if (pin) {
        const session = sessions.get(pin);
        if (session) {
          if (isHost) {
            // Host disconnected — notify all players
            io.to(`game-${pin}`).emit("host-disconnected");
            sessions.delete(pin);
          } else if (name) {
            session.players.delete(name);
            io.to(session.hostSocketId).emit("player-left", {
              name, playerCount: session.players.size, players: getPlayersArray(session),
            });
          }
        }
      }
      logger.info({ socketId: socket.id }, "Socket disconnected");
    });
  });

  return io;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPlayersArray(session: GameSession) {
  return [...session.players.values()].map(p => ({ name: p.name, avatar: p.avatar, score: p.score }));
}

function getPlayersScores(session: GameSession) {
  const result: Record<string, number> = {};
  session.players.forEach(p => { result[p.name] = p.score; });
  return result;
}

function getSortedLeaderboard(session: GameSession) {
  return [...session.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, avatar: p.avatar, score: p.score }));
}

function getCorrectIndexes(q: Record<string, unknown>): number[] {
  const answers = q["answers"] as Array<{ text: string; correct: boolean }>;
  if (!answers) return [];
  return answers.map((a, i) => a.correct ? i : -1).filter(i => i !== -1);
}

function getAnswerCounts(session: GameSession, qIdx: number): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  session.players.forEach(p => {
    const ans = p.answers[qIdx];
    if (ans !== undefined) counts[ans.choice] = (counts[ans.choice] || 0) + 1;
  });
  return counts;
}

function calculateScores(session: GameSession, qIdx: number) {
  const q = session.questions[qIdx] as Record<string, unknown>;
  const correctIndexes = getCorrectIndexes(q);
  const pts = (q["pts"] as string) || "standard";
  const multiplier = pts === "double" ? 2 : pts === "none" ? 0 : 1;
  const maxTime = ((q["time"] as number) || 20) * 1000; // ms
  const qStart = session.qStartTs;

  session.players.forEach(player => {
    const ans = player.answers[qIdx];
    if (ans === undefined) return;
    if (!correctIndexes.includes(ans.choice)) return;

    // Speed-based scoring: base 1000 pts, faster = more pts
    // Min 500 pts for correct, max 1000 pts for instant answer
    const elapsed = Math.max(0, ans.ts - qStart);
    const speed = Math.max(0, 1 - elapsed / maxTime);
    const base = 1000 * multiplier;
    const pts_earned = Math.round(base * (0.5 + 0.5 * speed));
    player.score += pts_earned;
  });
}

function getQuestionForPlayers(session: GameSession, qIdx: number) {
  const q = session.questions[qIdx] as Record<string, unknown>;
  if (!q) return null;
  const answers = q["answers"] as Array<{ text: string; correct: boolean }>;
  return {
    text: q["text"],
    time: q["time"],
    pts: q["pts"],
    answers: answers?.map(a => ({ text: a.text })),
  };
}
