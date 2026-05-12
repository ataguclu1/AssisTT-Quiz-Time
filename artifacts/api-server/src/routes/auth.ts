import { Router } from "express";
import { db } from "@workspace/db";
import { authorizedUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken } from "../middlewares/auth";

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

  const users = await db
    .select()
    .from(authorizedUsersTable)
    .where(eq(authorizedUsersTable.sicil, sicil));

  if (users.length === 0) {
    res.status(401).json({ error: "Bu sicil numarası sisteme kayıtlı değil." });
    return;
  }

  const user = users[0];
  const token = signToken({
    sicil: user.sicil,
    adSoyad: user.adSoyad,
    role: user.yetki as "full" | "limited" | "manager",
  });

  res.json({ token, role: user.yetki, adSoyad: user.adSoyad, sicil: user.sicil });
});

export default router;
