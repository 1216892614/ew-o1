import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Header } from "@/client/components/Header";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="flex flex-col h-screen">
      <Header />
      <Outlet />
    </div>
  );
}
