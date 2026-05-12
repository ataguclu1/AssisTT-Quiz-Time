import { Router } from "express";
import { db } from "@workspace/db";
import { authorizedUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

router.get("/", requireAdmin, async (_req, res) => {
  const users = await db.select().from(authorizedUsersTable).orderBy(authorizedUsersTable.createdAt);
  res.json(users);
});

router.post("/", requireAdmin, async (req, res) => {
  const { sicil, adSoyad, yetki } = req.body as { sicil: string; adSoyad: string; yetki: string };

  if (!sicil || !adSoyad || !yetki) {
    res.status(400).json({ error: "Sicil, ad soyad ve yetki zorunludur." });
    return;
  }
  if (!["full", "limited", "manager"].includes(yetki)) {
    res.status(400).json({ error: "Yetki 'limited', 'full' veya 'manager' olmalıdır." });
    return;
  }

  const existing = await db.select().from(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, sicil));
  if (existing.length > 0) {
    res.status(409).json({ error: "Bu sicil zaten kayıtlı." });
    return;
  }

  const [user] = await db.insert(authorizedUsersTable).values({ sicil, adSoyad, yetki }).returning();
  res.status(201).json(user);
});

router.delete("/:sicil", requireAdmin, async (req, res) => {
  const { sicil } = req.params;
  await db.delete(authorizedUsersTable).where(eq(authorizedUsersTable.sicil, sicil));
  res.json({ success: true });
});

export default router;
