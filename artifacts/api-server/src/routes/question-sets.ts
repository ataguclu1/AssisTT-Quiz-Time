import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { questionSetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireFull, type AuthPayload } from "../middlewares/auth";

const router = Router();

router.get("/", requireAuth, async (_req, res) => {
  const sets = await db
    .select()
    .from(questionSetsTable)
    .orderBy(questionSetsTable.createdAt);
  res.json(sets);
});

router.post("/", requireFull, async (req, res) => {
  const user = (req as Request & { user: AuthPayload }).user;
  const { name, questions } = req.body as { name: string; questions: unknown[] };

  if (!name || !questions || !Array.isArray(questions)) {
    res.status(400).json({ error: "Soru seti adı ve sorular gereklidir." });
    return;
  }
  if (questions.length === 0) {
    res.status(400).json({ error: "Soru seti en az 1 soru içermelidir." });
    return;
  }

  const [set] = await db
    .insert(questionSetsTable)
    .values({ name, questions, createdBy: user.sicil })
    .returning();
  res.status(201).json(set);
});

router.delete("/:id", requireFull, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Geçersiz ID." });
    return;
  }
  await db.delete(questionSetsTable).where(eq(questionSetsTable.id, id));
  res.json({ success: true });
});

export default router;
