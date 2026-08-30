import { Hono } from "hono";
import type { HonoCtxEnv } from "@/shared/types";
import type { ChatAnswerBody } from "@/shared/chat-types";

const chatRoute = new Hono<HonoCtxEnv>();

chatRoute.post("/api/chat", async (c) => {
  const body = (await c.req.json()) as { sessionId: string; notebookId: string };
  const sessionKey = `${body.notebookId}/${body.sessionId}`;
  const stub = c.env.CHAT_DO.getByName(sessionKey);
  stub.setSessionKey(sessionKey);

  const doRequest = new Request(c.req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await stub.chat(doRequest);
  return response;
});

chatRoute.get("/api/chat/messages", async (c) => {
  const sessionId = c.req.query("sessionId") ?? "";
  const notebookId = c.req.query("notebookId") ?? "";
  if (!sessionId || !notebookId) {
    return c.json({ error: "Missing sessionId or notebookId" }, 400);
  }
  const sessionKey = `${notebookId}/${sessionId}`;
  const stub = c.env.CHAT_DO.getByName(sessionKey);
  stub.setSessionKey(sessionKey);

  const result = await stub.getMessages();
  return c.json(result);
});

chatRoute.post("/api/chat/answer", async (c) => {
  const body = (await c.req.json()) as ChatAnswerBody;
  const sessionKey = `${body.notebookId}/${body.sessionId}`;
  const stub = c.env.CHAT_DO.getByName(sessionKey);
  stub.setSessionKey(sessionKey);
  await stub.answer(body.answers);
  return c.json({ success: true });
});

export { chatRoute };
