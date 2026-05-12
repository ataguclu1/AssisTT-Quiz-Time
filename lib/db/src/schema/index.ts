import { pgTable, serial, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const authorizedUsersTable = pgTable("authorized_users", {
  id: serial("id").primaryKey(),
  sicil: varchar("sicil", { length: 50 }).notNull().unique(),
  adSoyad: varchar("ad_soyad", { length: 255 }).notNull(),
  yetki: varchar("yetki", { length: 20 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const questionSetsTable = pgTable("question_sets", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  questions: jsonb("questions").notNull(),
  createdBy: varchar("created_by", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAuthorizedUserSchema = createInsertSchema(authorizedUsersTable).omit({ id: true, createdAt: true });
export const insertQuestionSetSchema = createInsertSchema(questionSetsTable).omit({ id: true, createdAt: true });

export type AuthorizedUser = typeof authorizedUsersTable.$inferSelect;
export type InsertAuthorizedUser = z.infer<typeof insertAuthorizedUserSchema>;
export type QuestionSet = typeof questionSetsTable.$inferSelect;
export type InsertQuestionSet = z.infer<typeof insertQuestionSetSchema>;
