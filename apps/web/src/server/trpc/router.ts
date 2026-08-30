import { router } from "./init";
import { notebooksRouter } from "./routers/notebooks";
import { notesRouter } from "./routers/notes";
import { timeMachineRouter } from "./routers/timeMachine";

export const appRouter = router({
  notebooks: notebooksRouter,
  notes: notesRouter,
  timeMachine: timeMachineRouter,
});

export type AppRouter = typeof appRouter;
