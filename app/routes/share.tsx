import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/share')({
  component: ShareLayout,
});

function ShareLayout() {
  return <Outlet />;
}
