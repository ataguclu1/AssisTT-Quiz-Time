import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "assistt-quiz-secret-2024";

export interface AuthPayload {
  sicil: string;
  adSoyad: string;
  role: "admin" | "full" | "limited";
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthPayload;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Oturum açmanız gerekiyor." });
    return;
  }
  const token = auth.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Geçersiz veya süresi dolmuş oturum." });
    return;
  }
  (req as Request & { user: AuthPayload }).user = payload;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as Request & { user: AuthPayload }).user;
    if (user?.role !== "admin") {
      res.status(403).json({ error: "Bu işlem için yönetici yetkisi gerekiyor." });
      return;
    }
    next();
  });
}

export function requireFull(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as Request & { user: AuthPayload }).user;
    if (user?.role !== "admin" && user?.role !== "full" && user?.role !== "manager") {
      res.status(403).json({ error: "Bu işlem için yetki gerekiyor." });
      return;
    }
    next();
  });
}

export function requireManager(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as Request & { user: AuthPayload }).user;
    if (user?.role !== "admin" && user?.role !== "manager") {
      res.status(403).json({ error: "Bu işlem için yönetici yetkisi gerekiyor." });
      return;
    }
    next();
  });
}
