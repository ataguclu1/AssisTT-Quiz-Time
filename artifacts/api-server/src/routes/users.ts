import { Router } from "express";
import { db } from "@workspace/db";
import { authorizedUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import bcrypt from "bcryptjs";

const router = Router();

router.get("/", requireAdmin, async (_req, res) => {
  const users = await db.select({
    id: authorizedUsersTable.id,
    sicil: authorizedUsersTable.sicil,
    adSoyad: authorizedUsersTable.adSoyad,
    yetki: authorizedUsersTable.yetki,
    createdAt: authorizedUsersTable.createdAt,
    hasPassword: authorizedUsersTable.passwordHash,
  }).from(authorizedUsersTable).orderBy(authorizedUsersTable.createdAt);

  const result = users.map(u => ({
    ...u,
    hasPassword: !!u.hasPassword,
  }));
  res.json(result);
});

router.post("/", requireAdmin, async (req, res) => {
  const { sicil, adSoyad, yetki, password } = req.body as {
    sicil: string;
    adSoyad: string;
    yetki: string;
    password: string;
  };

  if (!sicil || !adSoyad || !yetki || !password) {
    res.status(400).json({ error: "Sicil, ad soyad, yetki ve şifre zorunludur." });
    return;
  }
  if (!["full", "limited", "manager"].includes(yetki)) {
    res.status(400).json({ error: "Yetki 'limited', 'full' veya 'manager' olmalıdır." });
    return;
  }
  if (password.length < 4) {
    res.status(400).json({ error: "Şifre en az 4 karakter olmalıdır." });
    return;
  }

  const existing = await db.select().from(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, sicil));
  if (existing.length > 0) {
    res.status(409).json({ error: "Bu sicil zaten kayıtlı." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db
    .insert(authorizedUsersTable)
    .values({ sicil, adSoyad, yetki, passwordHash })
    .returning();

  res.status(201).json({ ...user, hasPassword: true, passwordHash: undefined });
});

router.patch("/:sicil/password", requireAdmin, async (req, res) => {
  const { sicil } = req.params;
  const { password } = req.body as { password: string };

  if (!password || password.length < 4) {
    res.status(400).json({ error: "Şifre en az 4 karakter olmalıdır." });
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await db
    .update(authorizedUsersTable)
    .set({ passwordHash: hash })
    .where(eq(authorizedUsersTable.sicil, sicil));

  res.json({ success: true });
});

router.delete("/:sicil", requireAdmin, async (req, res) => {
  const { sicil } = req.params;
  await db.delete(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, sicil));
  res.json({ success: true });
});

export default router;
