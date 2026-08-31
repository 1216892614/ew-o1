import { router } from "./init";
import { notebooksRouter } from "./routers/notebooks";
import { notesRouter } from "./routers/notes";
import { timeMachineRouter } from "./routers/timeMachine";
import { shareRouter } from "./routers/share";

export const appRouter = router({
  notebooks: notebooksRouter,
  notes: notesRouter,
  timeMachine: timeMachineRouter,
  share: shareRouter,
});

export type AppRouter = typeof appRouter;
