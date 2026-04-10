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
}

const sessions = new Map<string, GameSession>();

export function setupSocketIO(httpServer: HttpServer) {
  const io = new SocketIOServer(httpServer, {
    path: "/api/socket.io",
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Socket connected");

    socket.on("create-session", (data: { pin: string; questions: unknown[] }) => {
      const { pin, questions } = data;
      sessions.set(pin, {
        pin,
        hostSocketId: socket.id,
        phase: "lobby",
        qIdx: 0,
        questions,
        players: new Map(),
      });
      socket.join(`game-${pin}`);
      socket.emit("session-created", { pin });
      logger.info({ pin }, "Game session created");
    });

    socket.on("join-session", (data: { pin: string; name: string; avatar: { style: string; seed: string } }) => {
      const { pin, name, avatar } = data;
      const session = sessions.get(pin);

      if (!session) {
        socket.emit("join-error", { message: "Geçersiz PIN. Böyle bir oturum bulunamadı." });
        return;
      }

      if (session.phase !== "lobby") {
        socket.emit("join-error", { message: "Oturum çoktan başladı. Ana ekrandan tekrar deneyin." });
        return;
      }

      if (session.players.has(name)) {
        socket.emit("join-error", { message: "Bu isim şu an oturumda kullanımda." });
        return;
      }

      const player: PlayerData = {
        name,
        avatar,
        score: 0,
        answers: {},
        socketId: socket.id,
      };

      session.players.set(name, player);
      socket.join(`game-${pin}`);
      socket.data.pin = pin;
      socket.data.name = name;

      socket.emit("join-success", { pin, name });

      io.to(`game-${session.hostSocketId}`).emit("player-joined", {
        name,
        avatar,
        playerCount: session.players.size,
        players: getPlayersArray(session),
      });

      logger.info({ pin, name }, "Player joined session");
    });

    socket.on("start-game", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "question";
      session.qIdx = 0;

      io.to(`game-${data.pin}`).emit("game-started", {
        qIdx: 0,
        question: getQuestionForPlayers(session, 0),
        total: session.questions.length,
      });

      logger.info({ pin: data.pin }, "Game started");
    });

    socket.on("show-question", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "question";
      session.qIdx = data.qIdx;

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: data.qIdx,
        question: getQuestionForPlayers(session, data.qIdx),
        total: session.questions.length,
      });
    });

    socket.on("submit-answer", (data: { pin: string; name: string; qIdx: number; choice: number }) => {
      const { pin, name, qIdx, choice } = data;
      const session = sessions.get(pin);
      if (!session) return;

      const player = session.players.get(name);
      if (!player || player.answers[qIdx] !== undefined) return;

      player.answers[qIdx] = { choice, ts: Date.now() };

      const answeredCount = [...session.players.values()].filter(
        (p) => p.answers[qIdx] !== undefined
      ).length;

      socket.emit("answer-recorded", { qIdx, choice });

      io.to(`game-${session.hostSocketId}`).emit("player-answered", {
        name,
        qIdx,
        choice,
        answeredCount,
        totalPlayers: session.players.size,
        answerCounts: getAnswerCounts(session, qIdx),
      });

      if (answeredCount >= session.players.size) {
        io.to(`game-${session.hostSocketId}`).emit("all-answered", { qIdx });
      }
    });

    socket.on("reveal-answer", (data: { pin: string; qIdx: number }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "reveal";
      const q = (session.questions[data.qIdx] as Record<string, unknown>);

      calculateScores(session, data.qIdx);

      io.to(`game-${data.pin}`).emit("answer-revealed", {
        qIdx: data.qIdx,
        correctIndexes: getCorrectIndexes(q),
        playerScores: getPlayersScores(session),
      });

      logger.info({ pin: data.pin, qIdx: data.qIdx }, "Answer revealed");
    });

    socket.on("show-leaderboard", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.phase = "leaderboard";

      io.to(`game-${data.pin}`).emit("leaderboard-shown", {
        leaderboard: getSortedLeaderboard(session),
        isLast: session.qIdx >= session.questions.length - 1,
      });
    });

    socket.on("next-question", (data: { pin: string }) => {
      const session = sessions.get(data.pin);
      if (!session || session.hostSocketId !== socket.id) return;

      session.qIdx++;
      session.phase = "question";

      io.to(`game-${data.pin}`).emit("question-shown", {
        qIdx: session.qIdx,
        question: getQuestionForPlayers(session, session.qIdx),
        total: session.questions.length,
      });
    });

    socket.on("update-avatar", (data: { pin: string; name: string; avatar: { style: string; seed: string } }) => {
      const session = sessions.get(data.pin);
      if (!session) return;
      const player = session.players.get(data.name);
      if (!player) return;
      player.avatar = data.avatar;
      io.to(`game-${session.hostSocketId}`).emit("player-joined", {
        name: data.name,
        avatar: data.avatar,
        playerCount: session.players.size,
        players: getPlayersArray(session),
      });
    });

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

    socket.on("disconnect", () => {
      const pin = socket.data.pin as string | undefined;
      const name = socket.data.name as string | undefined;
      if (pin && name) {
        const session = sessions.get(pin);
        if (session) {
          session.players.delete(name);
          io.to(`game-${session.hostSocketId}`).emit("player-left", {
            name,
            playerCount: session.players.size,
            players: getPlayersArray(session),
          });
        }
      }
      logger.info({ socketId: socket.id }, "Socket disconnected");
    });
  });

  return io;
}

function getPlayersArray(session: GameSession) {
  return [...session.players.values()].map((p) => ({
    name: p.name,
    avatar: p.avatar,
    score: p.score,
  }));
}

function getPlayersScores(session: GameSession) {
  const result: Record<string, number> = {};
  session.players.forEach((p) => {
    result[p.name] = p.score;
  });
  return result;
}

function getSortedLeaderboard(session: GameSession) {
  return [...session.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
    }));
}

function getCorrectIndexes(q: Record<string, unknown>): number[] {
  const answers = q["answers"] as Array<{ text: string; correct: boolean }>;
  if (!answers) return [];
  return answers.map((a, i) => a.correct ? i : -1).filter((i) => i !== -1);
}

function getAnswerCounts(session: GameSession, qIdx: number): Record<number, number> {
  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  session.players.forEach((p) => {
    const ans = p.answers[qIdx];
    if (ans !== undefined) {
      counts[ans.choice] = (counts[ans.choice] || 0) + 1;
    }
  });
  return counts;
}

function calculateScores(session: GameSession, qIdx: number) {
  const q = session.questions[qIdx] as Record<string, unknown>;
  const correctIndexes = getCorrectIndexes(q);
  const pts = (q["pts"] as string) || "standard";
  const multiplier = pts === "double" ? 2 : pts === "none" ? 0 : 1;

  session.players.forEach((player) => {
    const ans = player.answers[qIdx];
    if (ans !== undefined && correctIndexes.includes(ans.choice)) {
      player.score += 100 * multiplier;
    }
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
    answers: answers?.map((a) => ({ text: a.text })),
  };
}
