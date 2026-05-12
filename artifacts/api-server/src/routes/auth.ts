import { Router } from "express";
import { db } from "@workspace/db";
import { authorizedUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middlewares/auth";
import type { AuthPayload } from "../middlewares/auth";
import type { Request } from "express";
import bcrypt from "bcryptjs";

const router = Router();

const ADMIN_SICIL = "A053252";
const ADMIN_PASSWORD = "admin123";

router.post("/login", async (req, res) => {
  const { sicil, password } = req.body as { sicil: string; password?: string };

  if (!sicil) {
    res.status(400).json({ error: "Sicil numarası gereklidir." });
    return;
  }

  if (sicil === ADMIN_SICIL) {
    if (password !== ADMIN_PASSWORD) {
      res.status(401).json({ error: "Hatalı şifre." });
      return;
    }
    const token = signToken({ sicil: ADMIN_SICIL, adSoyad: "Yönetici", role: "admin" });
    res.json({ token, role: "admin", adSoyad: "Yönetici", sicil: ADMIN_SICIL });
    return;
  }

  if (!password) {
    res.status(400).json({ error: "Şifre gereklidir." });
    return;
  }

  const users = await db
    .select()
    .from(authorizedUsersTable)
    .where(eq(authorizedUsersTable.sicil, sicil));

  if (users.length === 0) {
    res.status(401).json({ error: "Bu sicil numarası sisteme kayıtlı değil." });
    return;
  }

  const user = users[0];

  if (!user.passwordHash) {
    res.status(401).json({ error: "Bu kullanıcı için şifre henüz tanımlanmamış. Yöneticinizle iletişime geçin." });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Hatalı şifre." });
    return;
  }

  const token = signToken({
    sicil: user.sicil,
    adSoyad: user.adSoyad,
    role: user.yetki as "full" | "limited" | "manager",
  });

  res.json({ token, role: user.yetki, adSoyad: user.adSoyad, sicil: user.sicil });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const user = (req as Request & { user: AuthPayload }).user;
  const { oldPassword, newPassword } = req.body as { oldPassword: string; newPassword: string };

  if (user.role === "admin") {
    res.status(400).json({ error: "Yönetici şifresi bu panel üzerinden değiştirilemez." });
    return;
  }

  if (!oldPassword || !newPassword) {
    res.status(400).json({ error: "Mevcut ve yeni şifre zorunludur." });
    return;
  }
  if (newPassword.length < 4) {
    res.status(400).json({ error: "Yeni şifre en az 4 karakter olmalıdır." });
    return;
  }

  const users = await db
    .select()
    .from(authorizedUsersTable)
    .where(eq(authorizedUsersTable.sicil, user.sicil));

  if (!users.length) {
    res.status(404).json({ error: "Kullanıcı bulunamadı." });
    return;
  }

  const dbUser = users[0];

  if (dbUser.passwordHash) {
    const valid = await bcrypt.compare(oldPassword, dbUser.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Mevcut şifre hatalı." });
      return;
    }
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await db
    .update(authorizedUsersTable)
    .set({ passwordHash: hash })
    .where(eq(authorizedUsersTable.sicil, user.sicil));

  res.json({ success: true });
});

export default router;
