import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <h1 className="text-2xl font-bold text-base-content">ew-o1</h1>
    </div>
  );
}
