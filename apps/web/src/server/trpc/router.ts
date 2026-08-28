import { router } from "./init";
import { notebooksRouter } from "./routers/notebooks";
import { notesRouter } from "./routers/notes";

export const appRouter = router({
  notebooks: notebooksRouter,
  notes: notesRouter,
});

export type AppRouter = typeof appRouter;
