import { router } from "./init";
import { notebooksRouter } from "./routers/notebooks";

export const appRouter = router({
  notebooks: notebooksRouter,
});

export type AppRouter = typeof appRouter;
